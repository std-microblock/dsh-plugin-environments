//! Headless loopback RDP client, the logon half of separate-session mode.
//!
//! A genuinely separate Windows session can only be created by the logon stack, so the only way to
//! give an isolated account its own session (own pointer, real input) without a human at a screen is
//! to log it on over RDP to `127.0.0.1:3389`. `mstsc.exe` was doing that job, but it is a GUI
//! program: it ignores the `password 51:b:` line of a `.rdp` often enough to pop up a credentials
//! dialog, it shows a window on the human's desktop, and it reports nothing when it fails.
//!
//! This module speaks the client half of the protocol itself (IronRDP), so the logon is silent and
//! its failures are real error messages. Whatever the session's shell is (see
//! [`crate::winuser::session`], which points the account's own `Winlogon\Shell` at our server) runs
//! inside the new session while this client only has to hold the connection open: a disconnected RDP
//! session stops drawing, which would make every screenshot black.

#![cfg(windows)]

use anyhow::{Context as _, bail};
use ironrdp::connector::{self, Credentials, sspi};
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp::pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStageBuilder, ActiveStageOutput};
use serde_json::{Value, json};
use std::io::Write as _;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// CredSSP talks to no third-party service: the machine account of a local logon is authenticated
/// by NTLM against this very host, which is why no network client (and no HTTP stack) is needed.
struct NoNetwork;

impl sspi::network_client::NetworkClient for NoNetwork {
    fn send(&self, _: &sspi::generator::NetworkRequest) -> sspi::Result<Vec<u8>> {
        Err(sspi::Error::new(
            sspi::ErrorKind::NoAuthenticatingAuthority,
            "local logons authenticate with NTLM only",
        ))
    }
}

pub struct Options {
    pub account: String,
    pub password: String,
    /// NetBIOS name of this computer; NTLM wants a domain even for a local account.
    pub domain: Option<String>,
    pub host: String,
    pub port: u16,
    pub width: u16,
    pub height: u16,
    /// Program the session should run instead of the desktop shell (our server), if the client's
    /// alternate shell is honoured. The account's `Winlogon\Shell` carries the same command, which
    /// is what actually works on current Windows builds.
    pub shell: Option<String>,
}

/// Log the account on and hold the session open until stdin closes or the peer hangs up.
pub fn run(opts: &Options) -> anyhow::Result<Value> {
    let config = connector::Config {
        desktop_size: connector::DesktopSize {
            width: opts.width,
            height: opts.height,
        },
        desktop_scale_factor: 0,
        // NLA only: TLS without CredSSP shows a graphical logon screen, which is exactly the
        // interactive prompt this client exists to avoid.
        enable_tls: false,
        enable_credssp: true,
        credentials: Credentials::UsernamePassword {
            username: opts.account.clone(),
            password: opts.password.clone(),
        },
        domain: opts.domain.clone(),
        client_build: 0,
        client_name: "dsh-env".to_owned(),
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_functional_keys_count: 12,
        keyboard_layout: 0,
        ime_file_name: String::new(),
        bitmap: None,
        dig_product_id: String::new(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        alternate_shell: opts.shell.clone().unwrap_or_default(),
        work_dir: String::new(),
        platform: MajorPlatformType::WINDOWS,
        hardware_id: None,
        request_data: None,
        autologon: true,
        enable_audio_playback: false,
        performance_flags: PerformanceFlags::default(),
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        compression_type: None,
        // No pointer and no audio: the plugin reads pixels over its own connection to the server
        // inside the session, so the protocol channel is only here to keep the session alive.
        enable_server_pointer: false,
        pointer_software_rendering: true,
        multitransport_flags: None,
    };

    let started = Instant::now();
    let (mut framed, result) = connect(config, &opts.host, opts.port)?;
    let (width, height) = (result.desktop_size.width, result.desktop_size.height);
    let mut image = DecodedImage::new(
        ironrdp::graphics::image_processing::PixelFormat::RgbA32,
        width,
        height,
    );
    let mut stage = ActiveStageBuilder {
        static_channels: result.static_channels,
        user_channel_id: result.user_channel_id,
        io_channel_id: result.io_channel_id,
        message_channel_id: result.message_channel_id,
        share_id: result.share_id,
        compression_type: result.compression_type,
        enable_server_pointer: result.enable_server_pointer,
        pointer_software_rendering: result.pointer_software_rendering,
    }
    .build();

    // The caller prints this line and starts using the session once our server inside it answers.
    println!(
        "{}",
        json!({
            "ok": true,
            "connected": true,
            "desktop": { "width": width, "height": height },
            "connectMs": started.elapsed().as_millis() as u64,
        })
    );
    let _ = std::io::stdout().flush();

    let closed = watch_stdin();
    let mut frames = 0u64;
    loop {
        if closed.load(Ordering::Relaxed) {
            return Ok(json!({"ok": true, "reason": "stdin closed", "frames": frames}));
        }
        let (action, payload) = match framed.read_pdu() {
            Ok(v) => v,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(e) => return Err(anyhow::Error::new(e).context("reading from the session")),
        };
        for out in stage.process(&mut image, action, &payload)? {
            match out {
                ActiveStageOutput::ResponseFrame(frame) => framed.write_all(&frame)?,
                ActiveStageOutput::GraphicsUpdate(_) => frames += 1,
                ActiveStageOutput::Terminate(reason) => {
                    return Ok(
                        json!({"ok": true, "reason": format!("{reason:?}"), "frames": frames}),
                    );
                }
                _ => {}
            }
        }
    }
}

/// Set once the process's stdin reaches EOF, i.e. the plugin that spawned us went away.
fn watch_stdin() -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    let seen = flag.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 256];
        loop {
            match std::io::Read::read(&mut std::io::stdin(), &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
        seen.store(true, Ordering::Relaxed);
    });
    flag
}

type Upgraded = ironrdp_blocking::Framed<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>;

/// Negotiate security, authenticate with CredSSP/NLA and finish the connection sequence.
fn connect(
    config: connector::Config,
    host: &str,
    port: u16,
) -> anyhow::Result<(Upgraded, connector::ConnectionResult)> {
    let addr = std::net::ToSocketAddrs::to_socket_addrs(&(host, port))
        .with_context(|| format!("resolving {host}:{port}"))?
        .next()
        .with_context(|| format!("{host}:{port} did not resolve"))?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(10))
        .with_context(|| format!("connecting to {addr}"))?;
    // A read timeout is what lets the loop above notice a closed stdin between frames.
    tcp.set_read_timeout(Some(Duration::from_millis(500)))?;
    let client_addr = tcp.local_addr()?;

    let mut framed = ironrdp_blocking::Framed::new(tcp);
    let mut connector = connector::ClientConnector::new(config, client_addr);
    let should_upgrade =
        ironrdp_blocking::connect_begin(&mut framed, &mut connector).context("RDP negotiation")?;

    // CredSSP does not support TLS resumption, so the stream must be fresh.
    let (tls, public_key) = tls_upgrade(framed.into_inner_no_leftover()).context("TLS")?;
    let upgraded = ironrdp_blocking::mark_as_upgraded(should_upgrade, &mut connector);
    let mut framed = ironrdp_blocking::Framed::new(tls);
    let result = ironrdp_blocking::connect_finalize(
        upgraded,
        connector,
        &mut framed,
        &mut NoNetwork,
        connector::ServerName::new(host),
        public_key,
        None,
    )
    .context("logging on through Remote Desktop")?;
    Ok((framed, result))
}

fn tls_upgrade(
    tcp: TcpStream,
) -> anyhow::Result<(
    rustls::StreamOwned<rustls::ClientConnection, TcpStream>,
    Vec<u8>,
)> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        // The listener presents a self-signed certificate for this very machine; CredSSP binds the
        // credentials to the key we read below, so there is nothing to verify against a CA here.
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(LocalCertificate))
        .with_no_client_auth();
    config.resumption = rustls::client::Resumption::disabled();
    let mut stream = rustls::StreamOwned::new(
        rustls::ClientConnection::new(Arc::new(config), "127.0.0.1".try_into()?)?,
        tcp,
    );
    // Without a flush the handshake may not have progressed far enough to expose the certificate.
    stream.flush()?;
    let cert = stream
        .conn
        .peer_certificates()
        .and_then(|c| c.first())
        .context("the listener sent no certificate")?;
    use x509_cert::der::Decode as _;
    let cert = x509_cert::Certificate::from_der(cert)?;
    let key = cert
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .raw_bytes()
        .to_vec();
    if key.is_empty() {
        bail!("the listener certificate carries no public key");
    }
    Ok((stream, key))
}

/// Accept any certificate: the connection never leaves the loopback interface and CredSSP still
/// binds the logon to the public key the listener actually presented.
#[derive(Debug)]
struct LocalCertificate;

impl rustls::client::danger::ServerCertVerifier for LocalCertificate {
    fn verify_server_cert(
        &self,
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _: &[u8],
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}
