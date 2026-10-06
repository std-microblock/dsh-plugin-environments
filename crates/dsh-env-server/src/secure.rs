//! Secure channel for network transports (docs/protocol.md, "Secure channel").
//!
//! A pre-shared secret authenticates both peers and keys a ChaCha20-Poly1305 record layer:
//!
//! ```text
//! initiator -> responder  "DSHS" | 0x01 | nonce_i[32] | idLen u8 | id[idLen]
//! responder -> initiator  "DSHS" | 0x01 | nonce_r[32] | confirm_r[32]
//! initiator -> responder  confirm_i[32]
//! okm = HKDF-SHA256(salt = nonce_i || nonce_r, ikm = secret, info = "dsh-env secure v1\0" || id, 128)
//! k_i2r | k_r2i | m_i | m_r = okm
//! th = SHA-256(initiator hello || responder hello without confirm_r)
//! confirm_r = HMAC(m_r, "responder" || th); confirm_i = HMAC(m_i, "initiator" || th)
//! record = u32 BE len | ChaCha20-Poly1305(k_dir, nonce = 0u32 || seq u64 BE, aad = len, plaintext)
//! ```

use chacha20poly1305::aead::{AeadInPlace, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce, Tag};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::io;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use crate::transport::{BoxRead, BoxWrite, Stream};

pub const MAGIC: &[u8; 4] = b"DSHS";
pub const VERSION: u8 = 1;
/// Largest plaintext carried by one record.
pub const MAX_RECORD: usize = 64 * 1024;
const TAG: usize = 16;
const INFO: &[u8] = b"dsh-env secure v1\0";
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

fn invalid(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_string())
}

pub fn auth_error(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, msg.to_string())
}

/// Per-connection key material derived from the secret and both nonces.
pub struct Keys {
    pub i2r: [u8; 32],
    pub r2i: [u8; 32],
    pub confirm_i: [u8; 32],
    pub confirm_r: [u8; 32],
}

/// Derive keys; `transcript` is the initiator hello followed by the responder's magic, version
/// and nonce.
pub fn derive(
    secret: &[u8],
    nonce_i: &[u8; 32],
    nonce_r: &[u8; 32],
    id: &[u8],
    transcript: &[u8],
) -> Keys {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(nonce_i);
    salt[32..].copy_from_slice(nonce_r);
    let hk = Hkdf::<Sha256>::new(Some(&salt), secret);
    let mut info = Vec::with_capacity(INFO.len() + id.len());
    info.extend_from_slice(INFO);
    info.extend_from_slice(id);
    let mut okm = [0u8; 128];
    hk.expand(&info, &mut okm)
        .expect("128 bytes is a valid HKDF length");
    let th: [u8; 32] = Sha256::digest(transcript).into();
    let mac = |key: &[u8], label: &[u8]| -> [u8; 32] {
        let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("any key length");
        m.update(label);
        m.update(&th);
        m.finalize().into_bytes().into()
    };
    let mut keys = Keys {
        i2r: [0; 32],
        r2i: [0; 32],
        confirm_i: mac(&okm[64..96], b"initiator"),
        confirm_r: mac(&okm[96..128], b"responder"),
    };
    keys.i2r.copy_from_slice(&okm[..32]);
    keys.r2i.copy_from_slice(&okm[32..64]);
    keys
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// One direction of the record layer.
pub struct Sealer {
    aead: ChaCha20Poly1305,
    seq: u64,
}

impl Sealer {
    pub fn new(key: &[u8; 32]) -> Self {
        Sealer {
            aead: ChaCha20Poly1305::new(Key::from_slice(key)),
            seq: 0,
        }
    }

    fn nonce(&mut self) -> io::Result<[u8; 12]> {
        if self.seq == u64::MAX {
            return Err(invalid("record sequence exhausted"));
        }
        let mut n = [0u8; 12];
        n[4..].copy_from_slice(&self.seq.to_be_bytes());
        self.seq += 1;
        Ok(n)
    }

    /// Encrypt one record (`plain.len() <= MAX_RECORD`), returning the wire bytes.
    pub fn seal(&mut self, plain: &[u8]) -> io::Result<Vec<u8>> {
        let len = ((plain.len() + TAG) as u32).to_be_bytes();
        let nonce = self.nonce()?;
        let mut out = Vec::with_capacity(4 + plain.len() + TAG);
        out.extend_from_slice(&len);
        out.extend_from_slice(plain);
        let tag = self
            .aead
            .encrypt_in_place_detached(Nonce::from_slice(&nonce), &len, &mut out[4..])
            .map_err(|_| invalid("encryption failed"))?;
        out.extend_from_slice(&tag);
        Ok(out)
    }

    /// Decrypt one record body (`ciphertext || tag`) whose length prefix was `len`.
    pub fn open(&mut self, len: [u8; 4], mut body: Vec<u8>) -> io::Result<Vec<u8>> {
        if body.len() < TAG {
            return Err(invalid("short record"));
        }
        let nonce = self.nonce()?;
        let tag_at = body.len() - TAG;
        let tag = Tag::clone_from_slice(&body[tag_at..]);
        body.truncate(tag_at);
        self.aead
            .decrypt_in_place_detached(Nonce::from_slice(&nonce), &len, &mut body, &tag)
            .map_err(|_| invalid("record authentication failed"))?;
        Ok(body)
    }
}

/// Read one record body; `Ok(None)` on clean EOF at a record boundary.
async fn read_record<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<Option<([u8; 4], Vec<u8>)>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_be_bytes(len) as usize;
    if !(TAG..=MAX_RECORD + TAG).contains(&n) {
        return Err(invalid("bad record length"));
    }
    let mut body = vec![0u8; n];
    r.read_exact(&mut body).await?;
    Ok(Some((len, body)))
}

/// Run the initiator side of the handshake and return the encrypted stream.
pub async fn initiate(
    mut r: BoxRead,
    mut w: BoxWrite,
    secret: &[u8],
    id: &str,
) -> io::Result<Stream> {
    let id = id.as_bytes();
    if id.len() > 255 {
        return Err(invalid("id too long"));
    }
    let mut nonce_i = [0u8; 32];
    crate::util::random_bytes(&mut nonce_i);
    let mut hello = Vec::with_capacity(38 + id.len());
    hello.extend_from_slice(MAGIC);
    hello.push(VERSION);
    hello.extend_from_slice(&nonce_i);
    hello.push(id.len() as u8);
    hello.extend_from_slice(id);
    let keys = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        w.write_all(&hello).await?;
        w.flush().await?;
        let mut reply = [0u8; 69];
        r.read_exact(&mut reply).await.map_err(|e| {
            if e.kind() == io::ErrorKind::UnexpectedEof {
                auth_error(
                    "peer closed the connection during the handshake (unknown id or wrong secret?)",
                )
            } else {
                e
            }
        })?;
        if &reply[..4] != MAGIC || reply[4] != VERSION {
            return Err(invalid("peer does not speak the dsh-env secure channel"));
        }
        let nonce_r: [u8; 32] = reply[5..37].try_into().expect("32 bytes");
        let mut transcript = hello.clone();
        transcript.extend_from_slice(&reply[..37]);
        let keys = derive(secret, &nonce_i, &nonce_r, id, &transcript);
        if !ct_eq(&keys.confirm_r, &reply[37..]) {
            return Err(auth_error("peer failed to prove knowledge of the secret"));
        }
        w.write_all(&keys.confirm_i).await?;
        w.flush().await?;
        Ok(keys)
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "secure handshake timed out"))??;
    Ok(spawn_pumps(
        r,
        w,
        Sealer::new(&keys.r2i),
        Sealer::new(&keys.i2r),
    ))
}

/// Run the responder side. `lookup` maps the initiator's id to its secret (None = reject).
pub async fn respond<F>(mut r: BoxRead, mut w: BoxWrite, lookup: F) -> io::Result<(Stream, String)>
where
    F: FnOnce(&str) -> Option<Vec<u8>>,
{
    let (keys, id) = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        let mut head = [0u8; 38];
        r.read_exact(&mut head).await?;
        if &head[..4] != MAGIC {
            return Err(invalid("client does not speak the dsh-env secure channel"));
        }
        if head[4] != VERSION {
            return Err(invalid("unsupported secure channel version"));
        }
        let nonce_i: [u8; 32] = head[5..37].try_into().expect("32 bytes");
        let mut id = vec![0u8; head[37] as usize];
        r.read_exact(&mut id).await?;
        let id = String::from_utf8(id).map_err(|_| invalid("id is not UTF-8"))?;
        let secret = lookup(&id).ok_or_else(|| auth_error("unknown id"))?;
        let mut nonce_r = [0u8; 32];
        crate::util::random_bytes(&mut nonce_r);
        let mut reply = Vec::with_capacity(69);
        reply.extend_from_slice(MAGIC);
        reply.push(VERSION);
        reply.extend_from_slice(&nonce_r);
        let mut transcript = head.to_vec();
        transcript.extend_from_slice(id.as_bytes());
        transcript.extend_from_slice(&reply);
        let keys = derive(&secret, &nonce_i, &nonce_r, id.as_bytes(), &transcript);
        reply.extend_from_slice(&keys.confirm_r);
        w.write_all(&reply).await?;
        w.flush().await?;
        let mut confirm = [0u8; 32];
        r.read_exact(&mut confirm).await?;
        if !ct_eq(&keys.confirm_i, &confirm) {
            return Err(auth_error("client failed to prove knowledge of the secret"));
        }
        Ok((keys, id))
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "secure handshake timed out"))??;
    Ok((
        spawn_pumps(r, w, Sealer::new(&keys.i2r), Sealer::new(&keys.r2i)),
        id,
    ))
}

/// Bridge the encrypted network halves to a plaintext duplex stream.
fn spawn_pumps(mut r: BoxRead, mut w: BoxWrite, mut rx: Sealer, mut tx: Sealer) -> Stream {
    let (near, far) = tokio::io::duplex(256 * 1024);
    let (mut far_r, mut far_w) = tokio::io::split(far);
    let reader = tokio::spawn(async move {
        while let Ok(Some((len, body))) = read_record(&mut r).await {
            let Ok(plain) = rx.open(len, body) else { break };
            if far_w.write_all(&plain).await.is_err() {
                break;
            }
        }
        let _ = far_w.shutdown().await;
    });
    tokio::spawn(async move {
        let mut buf = vec![0u8; MAX_RECORD];
        loop {
            match far_r.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let Ok(rec) = tx.seal(&buf[..n]) else { break };
                    if w.write_all(&rec).await.is_err() || w.flush().await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = w.shutdown().await;
        reader.abort();
    });
    let (a, b) = tokio::io::split(near);
    (Box::new(a), Box::new(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (Stream, Stream) {
        let (a, b) = tokio::io::duplex(1 << 16);
        let (ar, aw) = tokio::io::split(a);
        let (br, bw) = tokio::io::split(b);
        ((Box::new(ar), Box::new(aw)), (Box::new(br), Box::new(bw)))
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    /// Known-answer vectors, shared with packages/protocol/test/secure.test.ts.
    #[test]
    fn known_answer() {
        let k = derive(b"s3cret", &[1; 32], &[2; 32], b"env1", b"transcript");
        let hex = crate::util::hex;
        assert_eq!(
            hex(&k.i2r),
            "e9b651db395dfa3b9061eda8c64ed31a4508a2aa0c328d847749631742c0df0a"
        );
        assert_eq!(
            hex(&k.r2i),
            "f67b710eeb64e796ca026c0839fc77a7740c1231b34e8129e3a9c32911b37f9d"
        );
        assert_eq!(
            hex(&k.confirm_i),
            "f9ffda2f74147fcb46dd2250f57fdc7853284c3ef757c1e1f1edbe5463834e74"
        );
        assert_eq!(
            hex(&k.confirm_r),
            "739bee7e2693c60b817611d9f5fe680d58bc15697807c2837b0deb47ed36c21d"
        );
        let rec = Sealer::new(&k.i2r).seal(b"hello").unwrap();
        assert_eq!(
            hex(&rec),
            "00000015b4732d8e75c46eee411a4f1d1ba0bf09b40d323331"
        );
    }

    #[test]
    fn records_roundtrip_and_detect_tampering() {
        let key = [7u8; 32];
        let mut a = Sealer::new(&key);
        let mut b = Sealer::new(&key);
        let rec = a.seal(b"hello").unwrap();
        let len: [u8; 4] = rec[..4].try_into().unwrap();
        assert_eq!(b.open(len, rec[4..].to_vec()).unwrap(), b"hello");
        // Tampered ciphertext.
        let mut rec = a.seal(b"world").unwrap();
        rec[5] ^= 1;
        let len: [u8; 4] = rec[..4].try_into().unwrap();
        assert!(b.open(len, rec[4..].to_vec()).is_err());
        // Replay of an earlier record fails (sequence numbers are nonces).
        let mut c = Sealer::new(&key);
        let mut d = Sealer::new(&key);
        let r0 = c.seal(b"x").unwrap();
        let len: [u8; 4] = r0[..4].try_into().unwrap();
        d.open(len, r0[4..].to_vec()).unwrap();
        assert!(d.open(len, r0[4..].to_vec()).is_err());
    }

    #[test]
    fn handshake_and_data() {
        rt().block_on(async {
            let ((ar, aw), (br, bw)) = pair();
            let srv = tokio::spawn(async move {
                let ((mut r, mut w), id) =
                    respond(br, bw, |id| (id == "env1").then(|| b"s3cret".to_vec()))
                        .await
                        .unwrap();
                assert_eq!(id, "env1");
                let mut buf = [0u8; 4];
                r.read_exact(&mut buf).await.unwrap();
                w.write_all(&buf).await.unwrap();
                w.flush().await.unwrap();
            });
            let (mut r, mut w) = initiate(ar, aw, b"s3cret", "env1").await.unwrap();
            w.write_all(b"ping").await.unwrap();
            w.flush().await.unwrap();
            let mut buf = [0u8; 4];
            r.read_exact(&mut buf).await.unwrap();
            assert_eq!(&buf, b"ping");
            srv.await.unwrap();
        });
    }

    #[test]
    fn wrong_secret_is_rejected_both_ways() {
        rt().block_on(async {
            let ((ar, aw), (br, bw)) = pair();
            let srv = tokio::spawn(async move {
                respond(br, bw, |_| Some(b"right".to_vec()))
                    .await
                    .map(|_| ())
            });
            let e = initiate(ar, aw, b"wrong", "").await.err().unwrap();
            assert_eq!(e.kind(), io::ErrorKind::PermissionDenied);
            assert!(srv.await.unwrap().is_err());

            let ((ar, aw), (br, bw)) = pair();
            let srv = tokio::spawn(async move { respond(br, bw, |_| None).await.map(|_| ()) });
            assert!(initiate(ar, aw, b"x", "nobody").await.is_err());
            assert!(srv.await.unwrap().is_err());
        });
    }
}
