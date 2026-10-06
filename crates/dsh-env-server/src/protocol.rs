//! Frame codec for the dsh environment protocol (see docs/protocol.md).

use serde_json::{Map, Value, json};
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Largest accepted frame body (header + payload + 4).
pub const MAX_FRAME: usize = 16 * 1024 * 1024 + 64 * 1024;
/// Largest payload chunk the server emits on a stream channel.
pub const CHUNK: usize = 256 * 1024;
/// Initial per-direction channel window.
pub const WINDOW: usize = 1024 * 1024;

/// One decoded frame.
#[derive(Debug, Clone)]
pub struct Frame {
    pub header: Map<String, Value>,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn new(header: Value) -> Self {
        Self::with_payload(header, Vec::new())
    }

    pub fn with_payload(header: Value, payload: Vec<u8>) -> Self {
        let header = match header {
            Value::Object(map) => map,
            other => {
                let mut map = Map::new();
                map.insert("value".into(), other);
                map
            }
        };
        Frame { header, payload }
    }

    pub fn kind(&self) -> &str {
        self.header.get("t").and_then(Value::as_str).unwrap_or("")
    }

    pub fn u64(&self, key: &str) -> Option<u64> {
        self.header.get(key).and_then(Value::as_u64)
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        self.header.get(key).and_then(Value::as_str)
    }
}

/// Read one frame; `Ok(None)` on clean EOF before a frame starts.
pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<Option<Frame>> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let frame_len = u32::from_be_bytes(len_buf) as usize;
    if !(4..=MAX_FRAME).contains(&frame_len) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("bad frame length {frame_len}"),
        ));
    }
    let mut body = vec![0u8; frame_len];
    reader.read_exact(&mut body).await?;
    let header_len = u32::from_be_bytes([body[0], body[1], body[2], body[3]]) as usize;
    if header_len > frame_len - 4 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bad header length",
        ));
    }
    let header: Value = serde_json::from_slice(&body[4..4 + header_len])
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("bad header json: {e}")))?;
    let Value::Object(header) = header else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "header is not an object",
        ));
    };
    let payload = body.split_off(4 + header_len);
    Ok(Some(Frame { header, payload }))
}

/// Encode a frame into bytes.
pub fn encode_frame(frame: &Frame) -> Vec<u8> {
    let header = serde_json::to_vec(&frame.header).unwrap_or_else(|_| b"{}".to_vec());
    let frame_len = 4 + header.len() + frame.payload.len();
    let mut out = Vec::with_capacity(4 + frame_len);
    out.extend_from_slice(&(frame_len as u32).to_be_bytes());
    out.extend_from_slice(&(header.len() as u32).to_be_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(&frame.payload);
    out
}

pub async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, frame: &Frame) -> io::Result<()> {
    writer.write_all(&encode_frame(frame)).await
}

/// Protocol-level error carried in `res` / `close` frames.
#[derive(Debug, Clone)]
pub struct OpError {
    pub code: &'static str,
    pub message: String,
}

impl OpError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        OpError {
            code,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("EINVAL", message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new("UNSUPPORTED", message)
    }

    pub fn to_json(&self) -> Value {
        json!({ "code": self.code, "message": self.message })
    }
}

impl From<io::Error> for OpError {
    fn from(e: io::Error) -> Self {
        use io::ErrorKind::*;
        let code = match e.kind() {
            NotFound => "ENOENT",
            AlreadyExists => "EEXIST",
            PermissionDenied => "EACCES",
            NotADirectory => "ENOTDIR",
            IsADirectory => "EISDIR",
            DirectoryNotEmpty => "ENOTEMPTY",
            InvalidInput | InvalidData => "EINVAL",
            _ => match e.raw_os_error() {
                // ERROR_DIRECTORY / ENOTDIR
                Some(267) | Some(20) => "ENOTDIR",
                // ERROR_DIR_NOT_EMPTY / ENOTEMPTY
                Some(145) | Some(39) | Some(66) => "ENOTEMPTY",
                // ERROR_ACCESS_DENIED / ERROR_SHARING_VIOLATION
                Some(5) | Some(32) => "EACCES",
                _ => "EIO",
            },
        };
        OpError::new(code, e.to_string())
    }
}

pub type OpResult = Result<(Value, Vec<u8>), OpError>;

/// Typed argument helpers over a JSON object.
pub struct Args<'a>(pub &'a Value);

impl<'a> Args<'a> {
    pub fn str(&self, key: &str) -> Result<&'a str, OpError> {
        self.0
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| OpError::invalid(format!("missing string argument `{key}`")))
    }
    pub fn opt_str(&self, key: &str) -> Option<&'a str> {
        self.0.get(key).and_then(Value::as_str)
    }
    pub fn bool(&self, key: &str, default: bool) -> bool {
        self.0.get(key).and_then(Value::as_bool).unwrap_or(default)
    }
    pub fn u64(&self, key: &str) -> Result<u64, OpError> {
        self.0
            .get(key)
            .and_then(Value::as_u64)
            .ok_or_else(|| OpError::invalid(format!("missing integer argument `{key}`")))
    }
    pub fn opt_u64(&self, key: &str) -> Option<u64> {
        self.0.get(key).and_then(Value::as_u64)
    }
    pub fn opt_f64(&self, key: &str) -> Option<f64> {
        self.0.get(key).and_then(Value::as_f64)
    }
}
