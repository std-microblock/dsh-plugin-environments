//! One protocol connection: request dispatch, channel multiplexing and flow control.

use crate::protocol::{
    Frame, OpError, OpResult, PROTOCOL_VERSION, WINDOW, read_frame, write_frame,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, BufWriter};
use tokio::sync::{Semaphore, mpsc, oneshot, watch};
use tokio::task::AbortHandle;

/// Client→server channel event.
#[derive(Debug)]
pub enum Inbound {
    Data(u8, Vec<u8>),
    Eof(u8),
    Close,
}

/// Out-of-band operations a channel owner supports (resize/kill).
pub trait ChannelControl: Send + Sync {
    fn resize(&self, _rows: u16, _cols: u16) -> Result<(), OpError> {
        Err(OpError::unsupported("channel cannot be resized"))
    }
    fn kill(&self, _signal: &str) -> Result<(), OpError> {
        Err(OpError::unsupported("channel cannot be killed"))
    }
}

struct Channel {
    inbound: mpsc::UnboundedSender<Inbound>,
    windows: HashMap<u8, Arc<Semaphore>>,
    control: Option<Arc<dyn ChannelControl>>,
    tasks: Vec<AbortHandle>,
    listener: Option<u64>,
}

struct Listener {
    task: AbortHandle,
    channels: Vec<u64>,
}

/// Receiving half handed to a channel owner.
pub struct ChannelHandle {
    pub ch: u64,
    pub inbound: mpsc::UnboundedReceiver<Inbound>,
}

pub struct Session {
    out: mpsc::UnboundedSender<Frame>,
    next_id: AtomicU64,
    channels: Mutex<HashMap<u64, Channel>>,
    requests: Mutex<HashMap<u64, AbortHandle>>,
    listeners: Mutex<HashMap<u64, Listener>>,
    pub cwd: PathBuf,
    pub info: Value,
}

impl Session {
    pub fn send(&self, frame: Frame) {
        let _ = self.out.send(frame);
    }

    pub fn send_json(&self, header: Value) {
        self.send(Frame::new(header));
    }

    pub fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn resolve(&self, path: &str, cwd: Option<&str>) -> PathBuf {
        let p = PathBuf::from(path);
        if p.is_absolute() {
            return p;
        }
        match cwd {
            Some(c) if !c.is_empty() => {
                let base = PathBuf::from(c);
                let base = if base.is_absolute() {
                    base
                } else {
                    self.cwd.join(base)
                };
                base.join(p)
            }
            _ => self.cwd.join(p),
        }
    }

    /// Register a channel whose server→client output uses the given fds.
    pub fn open_channel(
        &self,
        fds: &[u8],
        control: Option<Arc<dyn ChannelControl>>,
    ) -> ChannelHandle {
        let ch = self.alloc_id();
        self.open_channel_with_id(ch, fds, control, None)
    }

    pub fn open_channel_with_id(
        &self,
        ch: u64,
        fds: &[u8],
        control: Option<Arc<dyn ChannelControl>>,
        listener: Option<u64>,
    ) -> ChannelHandle {
        let (tx, rx) = mpsc::unbounded_channel();
        let windows = fds
            .iter()
            .map(|fd| (*fd, Arc::new(Semaphore::new(WINDOW))))
            .collect();
        self.channels.lock().unwrap().insert(
            ch,
            Channel {
                inbound: tx,
                windows,
                control,
                tasks: Vec::new(),
                listener,
            },
        );
        if let Some(id) = listener
            && let Some(l) = self.listeners.lock().unwrap().get_mut(&id)
        {
            l.channels.push(ch);
        }
        ChannelHandle { ch, inbound: rx }
    }

    pub fn set_control(&self, ch: u64, control: Arc<dyn ChannelControl>) {
        if let Some(c) = self.channels.lock().unwrap().get_mut(&ch) {
            c.control = Some(control);
        }
    }

    /// Attach a task to a channel so it is aborted when the channel closes.
    pub fn attach_task(&self, ch: u64, task: AbortHandle) {
        let mut map = self.channels.lock().unwrap();
        match map.get_mut(&ch) {
            Some(c) => c.tasks.push(task),
            None => task.abort(),
        }
    }

    pub fn channel_open(&self, ch: u64) -> bool {
        self.channels.lock().unwrap().contains_key(&ch)
    }

    /// Send channel data respecting the client's window. Returns false when the channel is gone.
    pub async fn send_data(&self, ch: u64, fd: Option<u8>, data: Vec<u8>) -> bool {
        let key = fd.unwrap_or(1);
        for chunk in data.chunks(crate::protocol::CHUNK) {
            let sem = {
                let map = self.channels.lock().unwrap();
                match map.get(&ch).and_then(|c| c.windows.get(&key)) {
                    Some(s) => s.clone(),
                    None => return false,
                }
            };
            if chunk.is_empty() {
                continue;
            }
            match sem.acquire_many(chunk.len() as u32).await {
                Ok(permit) => permit.forget(),
                Err(_) => return false,
            }
            if !self.channel_open(ch) {
                return false;
            }
            let header = match fd {
                Some(fd) => json!({"t":"data","ch":ch,"fd":fd}),
                None => json!({"t":"data","ch":ch}),
            };
            self.send(Frame::with_payload(header, chunk.to_vec()));
        }
        true
    }

    pub fn send_eof(&self, ch: u64, fd: Option<u8>) {
        if !self.channel_open(ch) {
            return;
        }
        match fd {
            Some(fd) => self.send_json(json!({"t":"eof","ch":ch,"fd":fd})),
            None => self.send_json(json!({"t":"eof","ch":ch})),
        }
    }

    /// Grant the client more window after consuming its data.
    pub fn grant(&self, ch: u64, fd: Option<u8>, n: usize) {
        if n == 0 || !self.channel_open(ch) {
            return;
        }
        match fd {
            Some(fd) => self.send_json(json!({"t":"win","ch":ch,"fd":fd,"n":n})),
            None => self.send_json(json!({"t":"win","ch":ch,"n":n})),
        }
    }

    /// Close a channel from the server side, sending a `close` frame.
    pub fn close_channel(&self, ch: u64, result: Option<Value>, error: Option<OpError>) {
        let entry = self.channels.lock().unwrap().remove(&ch);
        if let Some(entry) = entry {
            let mut header = json!({"t":"close","ch":ch});
            if let Some(r) = result {
                header["result"] = r;
            }
            if let Some(e) = error {
                header["error"] = e.to_json();
            }
            self.send_json(header);
            self.teardown(ch, entry, false);
        }
    }

    fn teardown(&self, ch: u64, entry: Channel, notify_owner: bool) {
        for sem in entry.windows.values() {
            sem.close();
        }
        if notify_owner {
            let _ = entry.inbound.send(Inbound::Close);
        }
        if let Some(id) = entry.listener
            && let Some(l) = self.listeners.lock().unwrap().get_mut(&id)
        {
            l.channels.retain(|c| *c != ch);
        }
        drop(entry.control);
        for t in entry.tasks {
            t.abort();
        }
    }

    pub fn control(&self, ch: u64) -> Result<Arc<dyn ChannelControl>, OpError> {
        let map = self.channels.lock().unwrap();
        let c = map
            .get(&ch)
            .ok_or_else(|| OpError::invalid(format!("unknown channel {ch}")))?;
        c.control
            .clone()
            .ok_or_else(|| OpError::unsupported("channel has no controls"))
    }

    pub fn add_listener(&self, id: u64, task: AbortHandle) {
        self.listeners.lock().unwrap().insert(
            id,
            Listener {
                task,
                channels: Vec::new(),
            },
        );
    }

    pub fn remove_listener(&self, id: u64) -> bool {
        let l = self.listeners.lock().unwrap().remove(&id);
        match l {
            Some(l) => {
                l.task.abort();
                for ch in l.channels {
                    self.close_channel(ch, None, None);
                }
                true
            }
            None => false,
        }
    }

    fn on_channel_frame(&self, frame: &Frame) {
        let Some(ch) = frame.u64("ch") else { return };
        let fd = frame.u64("fd").map(|f| f as u8);
        match frame.kind() {
            "data" => {
                let map = self.channels.lock().unwrap();
                if let Some(c) = map.get(&ch) {
                    let _ = c
                        .inbound
                        .send(Inbound::Data(fd.unwrap_or(0), frame.payload.clone()));
                }
            }
            "eof" => {
                let map = self.channels.lock().unwrap();
                if let Some(c) = map.get(&ch) {
                    let _ = c.inbound.send(Inbound::Eof(fd.unwrap_or(0)));
                }
            }
            "win" => {
                let n = frame.u64("n").unwrap_or(0) as usize;
                let map = self.channels.lock().unwrap();
                if let Some(sem) = map.get(&ch).and_then(|c| c.windows.get(&fd.unwrap_or(1))) {
                    let room = Semaphore::MAX_PERMITS.saturating_sub(sem.available_permits());
                    sem.add_permits(n.min(room));
                }
            }
            "close" => {
                let entry = self.channels.lock().unwrap().remove(&ch);
                if let Some(entry) = entry {
                    self.teardown(ch, entry, true);
                }
            }
            _ => {}
        }
    }

    fn shutdown(&self) {
        for (_, h) in self.requests.lock().unwrap().drain() {
            h.abort();
        }
        let listeners: Vec<u64> = self.listeners.lock().unwrap().keys().copied().collect();
        for id in listeners {
            if let Some(l) = self.listeners.lock().unwrap().remove(&id) {
                l.task.abort();
            }
        }
        let channels: Vec<(u64, Channel)> = self.channels.lock().unwrap().drain().collect();
        for (ch, entry) in channels {
            self.teardown(ch, entry, true);
        }
    }
}

/// Options for one connection.
pub struct ConnOptions {
    /// Token the hello must carry (plain transports); `None` accepts any token.
    pub token: Option<String>,
    pub cwd: PathBuf,
    pub idle_timeout: Option<Duration>,
    /// Ends the session (killing its processes) when it becomes `true`.
    pub shutdown: Option<watch::Receiver<bool>>,
    /// Signalled when a valid hello arrives (reverse connections dial their next spare).
    pub on_hello: Option<oneshot::Sender<()>>,
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Serve one connection until it closes.
pub async fn serve_connection<R, W>(
    mut reader: R,
    writer: W,
    opts: ConnOptions,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let mut writer = BufWriter::new(writer);
    let idle = opts.idle_timeout;
    async fn read_next<R: AsyncRead + Unpin>(
        reader: &mut R,
        timeout: Option<Duration>,
    ) -> std::io::Result<Option<Frame>> {
        match timeout {
            Some(t) => match tokio::time::timeout(t, read_frame(reader)).await {
                Ok(r) => r,
                Err(_) => Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "idle timeout",
                )),
            },
            None => read_frame(reader).await,
        }
    }

    let mut shutdown = opts.shutdown;
    async fn stopped(rx: &mut Option<watch::Receiver<bool>>) {
        match rx {
            Some(rx) => {
                let _ = rx.wait_for(|v| *v).await;
            }
            None => std::future::pending().await,
        }
    }

    // Handshake. A spare reverse connection may see keepalive pings before its hello.
    let hello = loop {
        let next = tokio::select! {
            f = read_next(&mut reader, idle) => f?,
            _ = stopped(&mut shutdown) => return Ok(()),
        };
        let Some(frame) = next else { return Ok(()) };
        if frame.kind() != "ping" {
            break frame;
        }
        let n = frame.header.get("n").cloned().unwrap_or(Value::Null);
        write_frame(&mut writer, &Frame::new(json!({"t":"pong","n":n}))).await?;
        tokio::io::AsyncWriteExt::flush(&mut writer).await?;
    };
    let info = crate::sys::info(&opts.cwd);
    if hello.kind() != "hello" {
        let f = Frame::new(
            json!({"t":"hello","v":PROTOCOL_VERSION,"ok":false,"error":{"code":"PROTOCOL","message":"expected hello"}}),
        );
        write_frame(&mut writer, &f).await?;
        tokio::io::AsyncWriteExt::flush(&mut writer).await?;
        return Ok(());
    }
    if let Some(expected) = &opts.token {
        let got = hello.str("token").unwrap_or("");
        if !constant_time_eq(expected.as_bytes(), got.as_bytes()) {
            let f = Frame::new(
                json!({"t":"hello","v":PROTOCOL_VERSION,"ok":false,"error":{"code":"AUTH","message":"invalid token"}}),
            );
            write_frame(&mut writer, &f).await?;
            tokio::io::AsyncWriteExt::flush(&mut writer).await?;
            return Ok(());
        }
    }

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Frame>();
    let session = Arc::new(Session {
        out: out_tx,
        next_id: AtomicU64::new(1),
        channels: Mutex::new(HashMap::new()),
        requests: Mutex::new(HashMap::new()),
        listeners: Mutex::new(HashMap::new()),
        cwd: opts.cwd.clone(),
        info: info.clone(),
    });
    session.send_json(json!({"t":"hello","v":PROTOCOL_VERSION,"ok":true,"info":info}));
    if let Some(tx) = opts.on_hello {
        let _ = tx.send(());
    }

    let writer_task = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            if write_frame(&mut writer, &frame).await.is_err() {
                break;
            }
            // Coalesce queued frames before flushing.
            while let Ok(frame) = out_rx.try_recv() {
                if write_frame(&mut writer, &frame).await.is_err() {
                    return;
                }
            }
            if tokio::io::AsyncWriteExt::flush(&mut writer).await.is_err() {
                break;
            }
        }
    });

    let result: std::io::Result<()> = async {
        loop {
            let next = tokio::select! {
                f = read_next(&mut reader, idle) => f?,
                _ = stopped(&mut shutdown) => None,
            };
            let Some(frame) = next else { break };
            match frame.kind() {
                "req" => {
                    let id = frame.u64("id").unwrap_or(0);
                    let op = frame.str("op").unwrap_or("").to_string();
                    let args = frame.header.get("args").cloned().unwrap_or(json!({}));
                    let payload = frame.payload;
                    let s = session.clone();
                    let task = tokio::spawn(async move {
                        let result = crate::ops::dispatch(&s, &op, &args, payload).await;
                        s.requests.lock().unwrap().remove(&id);
                        match result {
                            Ok((value, payload)) => {
                                s.send(Frame::with_payload(json!({"t":"res","id":id,"ok":true,"result":value}), payload))
                            }
                            Err(e) => s.send_json(json!({"t":"res","id":id,"ok":false,"error":e.to_json()})),
                        }
                    });
                    let handle = task.abort_handle();
                    if !task.is_finished() {
                        session.requests.lock().unwrap().insert(id, handle);
                    }
                }
                "cancel" => {
                    let id = frame.u64("id").unwrap_or(0);
                    let handle = session.requests.lock().unwrap().remove(&id);
                    if let Some(h) = handle {
                        h.abort();
                        session.send_json(json!({"t":"res","id":id,"ok":false,"error":{"code":"CANCELLED","message":"cancelled"}}));
                    }
                }
                "ping" => {
                    let n = frame.header.get("n").cloned().unwrap_or(Value::Null);
                    session.send_json(json!({"t":"pong","n":n}));
                }
                "pong" => {}
                "data" | "eof" | "win" | "close" => session.on_channel_frame(&frame),
                _ => {}
            }
        }
        Ok(())
    }
    .await;

    session.shutdown();
    drop(session);
    // Let the writer drain whatever is left (it ends when every sender is gone).
    let _ = tokio::time::timeout(Duration::from_secs(2), writer_task).await;
    result
}

/// Convenience used by ops that only need to know the connection is alive.
pub fn ok(value: Value) -> OpResult {
    Ok((value, Vec::new()))
}
