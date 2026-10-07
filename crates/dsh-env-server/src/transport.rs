//! Network transports: listening (`serve`) and dialing out (`connect`) over TCP or WebSocket,
//! always through the secure channel, plus lifetime control (lifeline, exit when unused).

use crate::session::{self, ConnOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Notify, oneshot, watch};

pub type BoxRead = Box<dyn AsyncRead + Unpin + Send>;
pub type BoxWrite = Box<dyn AsyncWrite + Unpin + Send>;
pub type Stream = (BoxRead, BoxWrite);

/// Where to listen or what to dial.
#[derive(Debug, Clone, PartialEq)]
pub enum Endpoint {
    Tcp { addr: String },
    Ws { addr: String, path: String },
}

impl Endpoint {
    /// Parse `host:port`, `tcp://host:port` or `ws://host:port[/path]`.
    pub fn parse(s: &str) -> Result<Endpoint, String> {
        let s = s.trim();
        if let Some(rest) = s.strip_prefix("ws://") {
            let (addr, path) = match rest.find('/') {
                Some(i) => (&rest[..i], &rest[i..]),
                None => (rest, "/"),
            };
            check_addr(addr)?;
            return Ok(Endpoint::Ws {
                addr: addr.to_string(),
                path: path.to_string(),
            });
        }
        if s.starts_with("wss://") {
            return Err(
                "wss:// is not supported by the server; listen on ws:// behind a TLS reverse proxy"
                    .into(),
            );
        }
        let addr = s.strip_prefix("tcp://").unwrap_or(s).trim_end_matches('/');
        if addr.contains("://") {
            return Err(format!(
                "unsupported address '{s}' (use host:port, tcp://host:port or ws://host:port/path)"
            ));
        }
        check_addr(addr)?;
        Ok(Endpoint::Tcp {
            addr: addr.to_string(),
        })
    }

    pub fn addr(&self) -> &str {
        match self {
            Endpoint::Tcp { addr } | Endpoint::Ws { addr, .. } => addr,
        }
    }
}

fn check_addr(addr: &str) -> Result<(), String> {
    match addr.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() && port.parse::<u16>().is_ok() => Ok(()),
        _ => Err(format!("address '{addr}' must be host:port")),
    }
}

/// Process-wide lifetime: active sessions and the shutdown signal.
pub struct Lifetime {
    active: AtomicUsize,
    used: AtomicBool,
    changed: Notify,
    shutdown: watch::Sender<bool>,
}

impl Lifetime {
    pub fn new() -> Arc<Lifetime> {
        Arc::new(Lifetime {
            active: AtomicUsize::new(0),
            used: AtomicBool::new(false),
            changed: Notify::new(),
            shutdown: watch::channel(false).0,
        })
    }

    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.shutdown.subscribe()
    }

    pub fn trigger(&self) {
        self.shutdown.send_replace(true);
        self.changed.notify_waiters();
    }

    pub fn is_shutdown(&self) -> bool {
        *self.shutdown.borrow()
    }

    fn enter(&self) {
        self.active.fetch_add(1, Ordering::SeqCst);
        self.used.store(true, Ordering::SeqCst);
        self.changed.notify_waiters();
    }

    fn leave(&self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
        self.changed.notify_waiters();
    }

    pub fn active(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }

    /// Wait until every session has shut down (bounded).
    pub async fn drain(&self, limit: Duration) {
        let deadline = Instant::now() + limit;
        while self.active() > 0 && Instant::now() < deadline {
            let _ = tokio::time::timeout(Duration::from_millis(100), self.changed.notified()).await;
        }
    }

    /// Exit when stdin reaches EOF (the parent / SSH channel went away).
    ///
    /// The watcher consumes stdin, so it must only be started once any `--token-stdin` read has
    /// finished (see [`read_secret`]): otherwise the two readers race and the watcher can swallow
    /// the secret line, leaving the secret read blocked forever.
    pub fn lifeline(self: &Arc<Self>) {
        let me = self.clone();
        let rt = tokio::runtime::Handle::current();
        std::thread::spawn(move || {
            let mut sink = [0u8; 256];
            let mut stdin = std::io::stdin();
            while let Ok(n) = std::io::Read::read(&mut stdin, &mut sink) {
                if n == 0 {
                    break;
                }
            }
            rt.spawn(async move { me.trigger() });
        });
    }
}

/// Read a secret: inline, from a file, or the first line of stdin.
pub fn read_secret(
    token: Option<String>,
    file: Option<PathBuf>,
    stdin: bool,
) -> io::Result<Option<String>> {
    let s = match (token, file) {
        (Some(t), _) => t,
        (None, Some(f)) => std::fs::read_to_string(f)?,
        (None, None) if stdin => {
            let mut line = String::new();
            std::io::stdin().read_line(&mut line)?;
            line
        }
        (None, None) => return Ok(None),
    };
    let s = s.trim().to_string();
    if s.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the secret is empty",
        ));
    }
    Ok(Some(s))
}

pub struct ServeOptions {
    pub listen: Endpoint,
    pub secret: String,
    pub cwd: PathBuf,
    pub once: bool,
    pub exit_idle: bool,
}

fn conn_opts(cwd: PathBuf, life: &Lifetime, on_hello: Option<oneshot::Sender<()>>) -> ConnOptions {
    ConnOptions {
        token: None,
        cwd,
        idle_timeout: Some(Duration::from_secs(60)),
        shutdown: Some(life.subscribe()),
        on_hello,
    }
}

/// Serve an authenticated stream as one session, counting it in `life`.
async fn run_session(stream: Stream, opts: ConnOptions, life: Arc<Lifetime>) -> io::Result<()> {
    life.enter();
    let (r, w) = stream;
    let r = session::serve_connection(r, w, opts).await;
    life.leave();
    r
}

/// `serve`: accept connections on a TCP or WebSocket listener.
pub async fn serve(opts: ServeOptions, life: Arc<Lifetime>) -> io::Result<()> {
    let listener = tokio::net::TcpListener::bind(opts.listen.addr()).await?;
    let local = listener.local_addr()?;
    let mut out = io::stdout();
    writeln!(out, "DSH_ENV_SERVER pid={}", std::process::id())?;
    if let Endpoint::Ws { path, .. } = &opts.listen {
        writeln!(out, "DSH_ENV_SERVER url=ws://{local}{path}")?;
    }
    writeln!(out, "DSH_ENV_SERVER listening={local}")?;
    out.flush()?;
    let secret = Arc::new(opts.secret.into_bytes());
    let mut shutdown = life.subscribe();
    loop {
        let accepted = tokio::select! {
            a = listener.accept() => a,
            _ = shutdown.wait_for(|v| *v) => return Ok(()),
            _ = wait_unused(&life), if opts.exit_idle => {
                life.trigger();
                return Ok(());
            }
        };
        let (stream, peer) = match accepted {
            Ok(a) => a,
            Err(e) => {
                eprintln!("dsh-env-server: accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        let (r, w) = stream.into_split();
        let (r, w): Stream = (Box::new(r), Box::new(w));
        let secret = secret.clone();
        let cwd = opts.cwd.clone();
        let listen = opts.listen.clone();
        let life2 = life.clone();
        let task = tokio::spawn(async move {
            let result = async {
                let (r, w) = match &listen {
                    Endpoint::Ws { path, .. } => crate::ws::accept(r, w, path).await?,
                    Endpoint::Tcp { .. } => (r, w),
                };
                let (stream, _id) = crate::secure::respond(r, w, |_| Some(secret.to_vec())).await?;
                run_session(stream, conn_opts(cwd, &life2, None), life2.clone()).await
            }
            .await;
            if let Err(e) = result {
                eprintln!("dsh-env-server: connection from {peer} ended: {e}");
            }
        });
        if opts.once {
            let _ = task.await;
            return Ok(());
        }
    }
}

/// Resolves once at least one session has run and none is active any more.
async fn wait_unused(life: &Lifetime) {
    loop {
        let notified = life.changed.notified();
        if life.used.load(Ordering::SeqCst) && life.active() == 0 {
            return;
        }
        notified.await;
    }
}

pub struct ConnectOptions {
    pub url: Endpoint,
    pub secret: String,
    pub id: String,
    pub cwd: PathBuf,
    pub max_sessions: usize,
}

async fn dial(url: &Endpoint, secret: &[u8], id: &str) -> io::Result<Stream> {
    let stream = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::net::TcpStream::connect(url.addr()),
    )
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "connect timed out"))??;
    let _ = stream.set_nodelay(true);
    let (r, w) = stream.into_split();
    let (r, w): Stream = (Box::new(r), Box::new(w));
    let (r, w) = match url {
        Endpoint::Ws { addr, path } => crate::ws::connect(r, w, addr, path).await?,
        Endpoint::Tcp { .. } => (r, w),
    };
    crate::secure::initiate(r, w, secret, id).await
}

/// `connect`: dial the plugin and keep one spare authenticated connection waiting. When the
/// plugin starts using it (sends `hello`) another spare is dialed. Failures back off
/// exponentially (1 s .. 60 s).
pub async fn connect(opts: ConnectOptions, life: Arc<Lifetime>) -> io::Result<()> {
    let secret = opts.secret.into_bytes();
    let mut backoff = Duration::from_secs(1);
    let mut announced = false;
    let mut shutdown = life.subscribe();
    while !life.is_shutdown() {
        if life.active() >= opts.max_sessions {
            tokio::select! {
                _ = life.changed.notified() => {}
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            }
            continue;
        }
        let started = Instant::now();
        let dialed = tokio::select! {
            d = dial(&opts.url, &secret, &opts.id) => d,
            _ = shutdown.wait_for(|v| *v) => break,
        };
        match dialed {
            Ok(stream) => {
                if !announced {
                    println!("DSH_ENV_SERVER connected={}", opts.url.addr());
                    let _ = io::stdout().flush();
                    announced = true;
                }
                let (used_tx, used_rx) = oneshot::channel();
                let cwd = opts.cwd.clone();
                let life2 = life.clone();
                tokio::spawn(async move {
                    let opts = conn_opts(cwd, &life2, Some(used_tx));
                    if let Err(e) = run_session(stream, opts, life2.clone()).await {
                        eprintln!("dsh-env-server: session ended: {e}");
                    }
                });
                // Wait until the spare is taken (dial the next one) or dropped (redial).
                let used = tokio::select! {
                    u = used_rx => u.is_ok(),
                    _ = shutdown.wait_for(|v| *v) => break,
                };
                if used || started.elapsed() > Duration::from_secs(5) {
                    backoff = Duration::from_secs(1);
                    continue;
                }
            }
            Err(e) => {
                if announced {
                    eprintln!("dsh-env-server: reconnecting to {}: {e}", opts.url.addr());
                } else {
                    eprintln!("dsh-env-server: cannot connect to {}: {e}", opts.url.addr());
                }
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = shutdown.wait_for(|v| *v) => break,
        }
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints() {
        assert_eq!(
            Endpoint::parse("127.0.0.1:7461").unwrap(),
            Endpoint::Tcp {
                addr: "127.0.0.1:7461".into()
            }
        );
        assert_eq!(
            Endpoint::parse("tcp://h:1/").unwrap(),
            Endpoint::Tcp { addr: "h:1".into() }
        );
        assert_eq!(
            Endpoint::parse("ws://[::1]:80/a/b?x").unwrap(),
            Endpoint::Ws {
                addr: "[::1]:80".into(),
                path: "/a/b?x".into()
            }
        );
        assert_eq!(
            Endpoint::parse("ws://h:80").unwrap(),
            Endpoint::Ws {
                addr: "h:80".into(),
                path: "/".into()
            }
        );
        assert!(Endpoint::parse("wss://h:443/").is_err());
        assert!(Endpoint::parse("http://h:1").is_err());
        assert!(Endpoint::parse("h").is_err());
        assert!(Endpoint::parse("h:99999").is_err());
    }
}
