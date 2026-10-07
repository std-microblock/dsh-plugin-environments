//! Minimal WebSocket (RFC 6455) transport: HTTP upgrade on both sides, binary frames,
//! masking, ping/pong and close. The binary message payloads form one byte stream.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use sha1::{Digest, Sha1};
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::transport::{BoxRead, BoxWrite, Stream};

const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/// Largest accepted frame payload.
pub const MAX_PAYLOAD: usize = 16 * 1024 * 1024 + 64 * 1024;
const MAX_HEADERS: usize = 16 * 1024;

pub const OP_CONT: u8 = 0;
pub const OP_TEXT: u8 = 1;
pub const OP_BINARY: u8 = 2;
pub const OP_CLOSE: u8 = 8;
pub const OP_PING: u8 = 9;
pub const OP_PONG: u8 = 10;

fn invalid(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.into())
}

/// `Sec-WebSocket-Accept` for a key.
pub fn accept_key(key: &str) -> String {
    let mut h = Sha1::new();
    h.update(key.trim().as_bytes());
    h.update(GUID.as_bytes());
    BASE64.encode(h.finalize())
}

/// Encode one (final) frame. Clients must pass a mask.
pub fn encode(opcode: u8, payload: &[u8], mask: Option<[u8; 4]>) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 14);
    out.push(0x80 | opcode);
    let m = if mask.is_some() { 0x80 } else { 0 };
    match payload.len() {
        n if n < 126 => out.push(m | n as u8),
        n if n <= 0xffff => {
            out.push(m | 126);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            out.push(m | 127);
            out.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    match mask {
        Some(k) => {
            out.extend_from_slice(&k);
            out.extend(payload.iter().enumerate().map(|(i, b)| b ^ k[i & 3]));
        }
        None => out.extend_from_slice(payload),
    }
    out
}

/// A decoded frame.
#[derive(Debug, PartialEq)]
pub struct WsFrame {
    pub fin: bool,
    pub opcode: u8,
    pub payload: Vec<u8>,
}

/// Read one frame. `expect_masked`: a server requires masked client frames, a client
/// requires unmasked server frames. `Ok(None)` on clean EOF before a frame.
pub async fn read_frame<R: AsyncRead + Unpin>(
    r: &mut R,
    expect_masked: bool,
) -> io::Result<Option<WsFrame>> {
    let mut h = [0u8; 2];
    match r.read_exact(&mut h).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let fin = h[0] & 0x80 != 0;
    if h[0] & 0x70 != 0 {
        return Err(invalid("reserved websocket bits set"));
    }
    let opcode = h[0] & 0x0f;
    let masked = h[1] & 0x80 != 0;
    if masked != expect_masked {
        return Err(invalid(if expect_masked {
            "client frames must be masked"
        } else {
            "server frames must not be masked"
        }));
    }
    let len = match h[1] & 0x7f {
        126 => {
            let mut b = [0u8; 2];
            r.read_exact(&mut b).await?;
            u16::from_be_bytes(b) as u64
        }
        127 => {
            let mut b = [0u8; 8];
            r.read_exact(&mut b).await?;
            u64::from_be_bytes(b)
        }
        n => n as u64,
    };
    if opcode >= 8 && (len > 125 || !fin) {
        return Err(invalid("bad websocket control frame"));
    }
    if len > MAX_PAYLOAD as u64 {
        return Err(invalid("websocket frame too large"));
    }
    let mut key = [0u8; 4];
    if masked {
        r.read_exact(&mut key).await?;
    }
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload).await?;
    if masked {
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= key[i & 3];
        }
    }
    Ok(Some(WsFrame {
        fin,
        opcode,
        payload,
    }))
}

/// Read an HTTP head (through the blank line). Returns the head and any bytes read past it.
async fn read_head<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<(String, Vec<u8>)> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf.split_off(i + 4);
            let head = String::from_utf8_lossy(&buf).into_owned();
            return Ok((head, rest));
        }
        if buf.len() > MAX_HEADERS {
            return Err(invalid("HTTP header too large"));
        }
        let n = r.read(&mut chunk).await?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "connection closed during HTTP upgrade",
            ));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.split("\r\n").skip(1).find_map(|line| {
        let (k, v) = line.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
    })
}

fn has_token(value: Option<&str>, token: &str) -> bool {
    value.is_some_and(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case(token)))
}

/// Reader that first yields buffered bytes, then the inner reader.
struct Prefixed {
    buf: Vec<u8>,
    pos: usize,
    inner: BoxRead,
}

impl AsyncRead for Prefixed {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        out: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        if self.pos < self.buf.len() {
            let n = (self.buf.len() - self.pos).min(out.remaining());
            let start = self.pos;
            out.put_slice(&self.buf[start..start + n]);
            self.pos += n;
            return std::task::Poll::Ready(Ok(()));
        }
        std::pin::Pin::new(&mut self.inner).poll_read(cx, out)
    }
}

/// Server side: answer the HTTP upgrade (the request path must equal `path`).
pub async fn accept(mut r: BoxRead, mut w: BoxWrite, path: &str) -> io::Result<Stream> {
    let (head, rest) = read_head(&mut r).await?;
    let mut first = head.split("\r\n").next().unwrap_or("").split(' ');
    let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let target_path = target.split('?').next().unwrap_or("");
    let reject = |status: &str| {
        format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
    };
    if method != "GET" || target_path != path {
        w.write_all(reject("404 Not Found").as_bytes()).await?;
        w.flush().await?;
        return Err(invalid(format!("unexpected request {method} {target}")));
    }
    let key = header(&head, "sec-websocket-key");
    if !has_token(header(&head, "upgrade"), "websocket") || key.is_none() {
        w.write_all(reject("426 Upgrade Required").as_bytes())
            .await?;
        w.flush().await?;
        return Err(invalid("not a websocket upgrade"));
    }
    let resp = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
        accept_key(key.unwrap_or(""))
    );
    w.write_all(resp.as_bytes()).await?;
    w.flush().await?;
    let r: BoxRead = Box::new(Prefixed {
        buf: rest,
        pos: 0,
        inner: r,
    });
    Ok(spawn_pumps(r, w, false))
}

/// Client side: perform the upgrade request for `host` (Host header) and `path`.
pub async fn connect(
    mut r: BoxRead,
    mut w: BoxWrite,
    host: &str,
    path: &str,
) -> io::Result<Stream> {
    let mut nonce = [0u8; 16];
    crate::util::random_bytes(&mut nonce);
    let key = BASE64.encode(nonce);
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: dsh-env-server/{}\r\n\r\n",
        crate::sys::VERSION
    );
    w.write_all(req.as_bytes()).await?;
    w.flush().await?;
    let (head, rest) = read_head(&mut r).await?;
    let status = head.split("\r\n").next().unwrap_or("");
    if status.split(' ').nth(1) != Some("101") {
        return Err(invalid(format!("websocket upgrade refused: {status}")));
    }
    if header(&head, "sec-websocket-accept") != Some(accept_key(&key).as_str()) {
        return Err(invalid("bad Sec-WebSocket-Accept"));
    }
    let r: BoxRead = Box::new(Prefixed {
        buf: rest,
        pos: 0,
        inner: r,
    });
    Ok(spawn_pumps(r, w, true))
}

fn mask_key(client: bool) -> Option<[u8; 4]> {
    client.then(|| crate::util::random_u32().to_be_bytes())
}

/// Bridge websocket frames to a plain duplex byte stream.
fn spawn_pumps(mut r: BoxRead, mut w: BoxWrite, client: bool) -> Stream {
    let (near, far) = tokio::io::duplex(256 * 1024);
    let (mut far_r, mut far_w) = tokio::io::split(far);
    // Every frame to the peer goes through one writer task.
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let writer = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if w.write_all(&frame).await.is_err() {
                return;
            }
            while let Ok(frame) = rx.try_recv() {
                if w.write_all(&frame).await.is_err() {
                    return;
                }
            }
            if w.flush().await.is_err() {
                return;
            }
        }
        let _ = w.shutdown().await;
    });
    let ctl = tx.clone();
    let reader = tokio::spawn(async move {
        while let Ok(Some(f)) = read_frame(&mut r, !client).await {
            match f.opcode {
                OP_BINARY | OP_CONT => {
                    if far_w.write_all(&f.payload).await.is_err() {
                        break;
                    }
                }
                OP_PING => {
                    let _ = ctl.send(encode(OP_PONG, &f.payload, mask_key(client)));
                }
                OP_PONG => {}
                OP_CLOSE => {
                    let code = f.payload.get(..2).unwrap_or(&[0x03, 0xe8]).to_vec();
                    let _ = ctl.send(encode(OP_CLOSE, &code, mask_key(client)));
                    break;
                }
                // Text frames are not part of this protocol.
                _ => break,
            }
        }
        let _ = far_w.shutdown().await;
    });
    tokio::spawn(async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match far_r.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx
                        .send(encode(OP_BINARY, &buf[..n], mask_key(client)))
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        let _ = tx.send(encode(OP_CLOSE, &1000u16.to_be_bytes(), mask_key(client)));
        drop(tx);
        // Give the peer a moment to answer the close, then stop reading.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), writer).await;
        reader.abort();
    });
    let (a, b) = tokio::io::split(near);
    (Box::new(a), Box::new(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn rfc_accept_key() {
        assert_eq!(
            accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn frame_codec_roundtrip() {
        rt().block_on(async {
            for len in [0usize, 5, 125, 126, 65535, 65536, 200_000] {
                let payload: Vec<u8> = (0..len).map(|i| (i * 31) as u8).collect();
                for mask in [None, Some([1, 2, 3, 4])] {
                    let bytes = encode(OP_BINARY, &payload, mask);
                    let mut r = &bytes[..];
                    let f = read_frame(&mut r, mask.is_some()).await.unwrap().unwrap();
                    assert_eq!(
                        f,
                        WsFrame {
                            fin: true,
                            opcode: OP_BINARY,
                            payload: payload.clone()
                        }
                    );
                    // Wrong masking expectation is rejected.
                    let mut r = &bytes[..];
                    assert!(read_frame(&mut r, mask.is_none()).await.is_err());
                }
            }
            // RFC 6455 5.7 example: masked "Hello".
            let ex = [
                0x81u8, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58,
            ];
            let mut r = &ex[..];
            let f = read_frame(&mut r, true).await.unwrap().unwrap();
            assert_eq!((f.opcode, &f.payload[..]), (OP_TEXT, &b"Hello"[..]));
            // Oversized control frame.
            let bad = encode(OP_PING, &[0u8; 126], None);
            let mut r = &bad[..];
            assert!(read_frame(&mut r, false).await.is_err());
        });
    }

    #[test]
    fn upgrade_and_stream_both_ways() {
        rt().block_on(async {
            let (a, b) = tokio::io::duplex(1 << 16);
            let (ar, aw) = tokio::io::split(a);
            let (br, bw) = tokio::io::split(b);
            let srv = tokio::spawn(async move {
                let (mut r, mut w) = accept(Box::new(br), Box::new(bw), "/env").await.unwrap();
                let mut buf = vec![0u8; 100_000];
                r.read_exact(&mut buf).await.unwrap();
                w.write_all(&buf).await.unwrap();
                w.flush().await.unwrap();
            });
            let (mut r, mut w) = connect(Box::new(ar), Box::new(aw), "x", "/env")
                .await
                .unwrap();
            let data: Vec<u8> = (0..100_000).map(|i| (i % 253) as u8).collect();
            w.write_all(&data).await.unwrap();
            w.flush().await.unwrap();
            let mut back = vec![0u8; data.len()];
            r.read_exact(&mut back).await.unwrap();
            assert_eq!(back, data);
            srv.await.unwrap();
        });
    }

    #[test]
    fn wrong_path_is_refused() {
        rt().block_on(async {
            let (a, b) = tokio::io::duplex(1 << 16);
            let (ar, aw) = tokio::io::split(a);
            let (br, bw) = tokio::io::split(b);
            let srv = tokio::spawn(async move {
                accept(Box::new(br), Box::new(bw), "/env").await.map(|_| ())
            });
            assert!(
                connect(Box::new(ar), Box::new(aw), "x", "/other")
                    .await
                    .is_err()
            );
            assert!(srv.await.unwrap().is_err());
        });
    }
}
