//! Process spawning (pipes and PTY).

use crate::protocol::{Args, OpError, OpResult};
use crate::session::{ChannelControl, Inbound, Session, ok};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(windows)]
pub mod job {
    use std::mem::{size_of, zeroed};
    use std::ptr::null;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::*;

    pub struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> Option<Job> {
            unsafe {
                let h = CreateJobObjectW(null(), null());
                if h.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                Some(Job(h))
            }
        }
        pub fn assign(&self, process: HANDLE) -> bool {
            unsafe { AssignProcessToJobObject(self.0, process) != 0 }
        }
        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Resolve the argv for a spawn request.
fn build_argv(a: &Args<'_>) -> Result<Vec<String>, OpError> {
    if let Some(argv) = a.0.get("argv").and_then(Value::as_array) {
        let argv: Vec<String> = argv
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        if argv.is_empty() {
            return Err(OpError::invalid("argv must not be empty"));
        }
        return Ok(argv);
    }
    if let Some(command) = a.opt_str("command") {
        let (prog, mut prefix) = crate::sys::shell_invocation();
        prefix.push(command.to_string());
        let mut argv = vec![prog];
        argv.extend(prefix);
        return Ok(argv);
    }
    Err(OpError::invalid("one of argv / command is required"))
}

fn env_ops(a: &Args<'_>) -> Vec<(String, Option<String>)> {
    a.0.get("env")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), v.as_str().map(str::to_string)))
                .collect()
        })
        .unwrap_or_default()
}

pub async fn spawn(s: &Arc<Session>, a: Args<'_>) -> OpResult {
    let argv = build_argv(&a)?;
    let cwd = s.resolve(a.opt_str("cwd").unwrap_or("."), None);
    if !cwd.is_dir() {
        return Err(OpError::new(
            "ENOENT",
            format!("cwd does not exist: {}", cwd.display()),
        ));
    }
    let env = env_ops(&a);
    let clear_env = a.bool("clearEnv", false);
    if let Some(pty) = a.0.get("pty").filter(|v| v.is_object()) {
        let rows = pty
            .get("rows")
            .and_then(Value::as_u64)
            .unwrap_or(24)
            .clamp(2, 1000) as u16;
        let cols = pty
            .get("cols")
            .and_then(Value::as_u64)
            .unwrap_or(80)
            .clamp(2, 1000) as u16;
        spawn_pty(s, argv, cwd, env, clear_env, rows, cols)
    } else {
        spawn_pipes(s, argv, cwd, env, clear_env)
    }
}

// ---------------------------------------------------------------- pipes

struct PipeControl {
    pid: u32,
    #[cfg(windows)]
    job: Option<Arc<job::Job>>,
}

impl ChannelControl for PipeControl {
    fn kill(&self, signal: &str) -> Result<(), OpError> {
        kill_tree(self, signal);
        Ok(())
    }
}

impl Drop for PipeControl {
    fn drop(&mut self) {
        kill_tree(self, "KILL");
    }
}

#[cfg(windows)]
fn kill_tree(c: &PipeControl, _signal: &str) {
    if let Some(job) = &c.job {
        job.terminate();
    } else {
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &c.pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

#[cfg(unix)]
fn kill_tree(c: &PipeControl, signal: &str) {
    let sig = match signal {
        "TERM" => libc::SIGTERM,
        "INT" => libc::SIGINT,
        _ => libc::SIGKILL,
    };
    unsafe {
        libc::killpg(c.pid as libc::pid_t, sig);
    }
}

fn exit_json(ch: u64, code: Option<i32>, signal: Option<String>) -> Value {
    json!({"t":"exit","ch":ch,"code":code,"signal":signal})
}

fn spawn_pipes(
    s: &Arc<Session>,
    argv: Vec<String>,
    cwd: PathBuf,
    env: Vec<(String, Option<String>)>,
    clear_env: bool,
) -> OpResult {
    use std::process::Stdio;
    let mut cmd = tokio::process::Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if clear_env {
        cmd.env_clear();
    }
    for (k, v) in &env {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| {
        let mut err: OpError = e.into();
        err.message = format!("failed to spawn {}: {}", argv[0], err.message);
        err
    })?;
    let pid = child.id().unwrap_or(0);
    #[cfg(windows)]
    let job = {
        let job = job::Job::new().map(Arc::new);
        if let (Some(j), Some(h)) = (&job, child.raw_handle()) {
            j.assign(h as _);
        }
        job
    };
    let control = Arc::new(PipeControl {
        pid,
        #[cfg(windows)]
        job,
    });
    let mut handle = s.open_channel(&[1, 2], Some(control));
    let ch = handle.ch;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut stdin = child.stdin.take();

    fn pump<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
        s: Arc<Session>,
        ch: u64,
        fd: u8,
        mut r: R,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match r.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if !s.send_data(ch, Some(fd), buf[..n].to_vec()).await {
                            return;
                        }
                    }
                }
            }
            s.send_eof(ch, Some(fd));
        })
    }

    let out_task = stdout.map(|o| pump(s.clone(), ch, 1, o));
    let err_task = stderr.map(|e| pump(s.clone(), ch, 2, e));
    if let Some(t) = &out_task {
        s.attach_task(ch, t.abort_handle());
    }
    if let Some(t) = &err_task {
        s.attach_task(ch, t.abort_handle());
    }

    // stdin writer
    let sin = s.clone();
    let stdin_task = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        while let Some(ev) = handle.inbound.recv().await {
            match ev {
                Inbound::Data(_, data) => {
                    let n = data.len();
                    if let Some(w) = stdin.as_mut()
                        && (w.write_all(&data).await.is_err() || w.flush().await.is_err())
                    {
                        stdin = None;
                    }
                    sin.grant(ch, Some(0), n);
                }
                Inbound::Eof(_) => {
                    if let Some(mut w) = stdin.take() {
                        let _ = w.shutdown().await;
                    }
                }
                Inbound::Close => break,
            }
        }
    });
    s.attach_task(ch, stdin_task.abort_handle());

    let sw = s.clone();
    let wait_task = tokio::spawn(async move {
        let status = child.wait().await;
        for t in [out_task, err_task].into_iter().flatten() {
            let _ = tokio::time::timeout(Duration::from_secs(3), t).await;
        }
        let (code, signal) = match status {
            Ok(st) => {
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    (st.code(), st.signal().map(|s| format!("SIG{s}")))
                }
                #[cfg(not(unix))]
                {
                    (st.code(), None::<String>)
                }
            }
            Err(_) => (None, None),
        };
        if sw.channel_open(ch) {
            sw.send_json(exit_json(ch, code, signal));
            sw.close_channel(ch, None, None);
        }
    });
    s.attach_task(ch, wait_task.abort_handle());
    ok(json!({ "ch": ch, "pid": pid }))
}

// ---------------------------------------------------------------- pty

struct PtyControl {
    master: Mutex<Option<crate::pty::PtyMaster>>,
    killer: crate::pty::PtyKiller,
    #[cfg(windows)]
    job: Option<Arc<job::Job>>,
}

impl ChannelControl for PtyControl {
    fn resize(&self, rows: u16, cols: u16) -> Result<(), OpError> {
        let guard = self.master.lock().unwrap();
        let m = guard
            .as_ref()
            .ok_or_else(|| OpError::invalid("terminal closed"))?;
        m.resize(rows, cols)
            .map_err(|e| OpError::new("EIO", e.to_string()))
    }
    fn kill(&self, signal: &str) -> Result<(), OpError> {
        #[cfg(windows)]
        if let Some(j) = &self.job {
            j.terminate();
        }
        self.killer.kill(signal);
        Ok(())
    }
}

impl Drop for PtyControl {
    fn drop(&mut self) {
        let _ = self.kill("KILL");
        self.master.lock().unwrap().take();
    }
}

fn spawn_pty(
    s: &Arc<Session>,
    argv: Vec<String>,
    cwd: PathBuf,
    mut env: Vec<(String, Option<String>)>,
    clear_env: bool,
    rows: u16,
    cols: u16,
) -> OpResult {
    if std::env::var_os("TERM").is_none() {
        env.insert(0, ("TERM".into(), Some("xterm-256color".into())));
    }
    let cmd = crate::pty::PtyCommand {
        argv,
        cwd,
        env,
        clear_env,
    };
    #[cfg(windows)]
    let job = job::Job::new().map(Arc::new);
    #[cfg(windows)]
    let spawned = crate::pty::spawn(&cmd, rows, cols, job.as_deref());
    #[cfg(unix)]
    let spawned = crate::pty::spawn(&cmd, rows, cols);
    let (master, child) = spawned.map_err(|e| {
        let mut err: OpError = e.into();
        err.message = format!("failed to spawn {}: {}", cmd.argv[0], err.message);
        err
    })?;
    let pid = child.pid();
    let io_err = |e: std::io::Error| OpError::new("EIO", e.to_string());
    let mut reader = master.reader().map_err(io_err)?;
    let mut writer = master.writer().map_err(io_err)?;
    let killer = child.killer();

    let control = Arc::new(PtyControl {
        master: Mutex::new(Some(master)),
        killer,
        #[cfg(windows)]
        job,
    });
    let mut handle = s.open_channel(&[1], Some(control.clone() as Arc<dyn ChannelControl>));
    let ch = handle.ch;
    let weak_control = Arc::downgrade(&control);
    drop(control);

    // Writer thread.
    let (wtx, wrx) = std::sync::mpsc::channel::<Option<Vec<u8>>>();
    std::thread::spawn(move || {
        while let Ok(Some(data)) = wrx.recv() {
            if std::io::Write::write_all(&mut writer, &data).is_err() {
                break;
            }
            let _ = std::io::Write::flush(&mut writer);
        }
    });

    // Reader thread -> async forwarder. ConPTY asks for the cursor position (ESC[6n) and
    // blocks until it gets an answer; reply on behalf of headless clients.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
    let dsr_tx = wtx.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    if chunk.windows(4).any(|w| w == b"\x1b[6n") {
                        let _ = dsr_tx.send(Some(b"\x1b[1;1R".to_vec()));
                    }
                    if tx.blocking_send(chunk.to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let sf = s.clone();
    let forward = tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            if !sf.send_data(ch, Some(1), chunk).await {
                return;
            }
        }
        sf.send_eof(ch, Some(1));
    });
    s.attach_task(ch, forward.abort_handle());

    let sin = s.clone();

    let stdin_task = tokio::spawn(async move {
        while let Some(ev) = handle.inbound.recv().await {
            match ev {
                Inbound::Data(_, data) => {
                    let n = data.len();
                    let _ = wtx.send(Some(data));
                    sin.grant(ch, Some(0), n);
                }
                Inbound::Eof(_) => {
                    // A terminal has no stdin EOF; send ^D on posix, ^Z on Windows.
                    let eof = if cfg!(windows) {
                        b"\x1a\r".to_vec()
                    } else {
                        vec![4u8]
                    };
                    let _ = wtx.send(Some(eof));
                }
                Inbound::Close => break,
            }
        }
        let _ = wtx.send(None);
    });
    s.attach_task(ch, stdin_task.abort_handle());

    // Wait thread.
    let (etx, erx) = tokio::sync::oneshot::channel::<Option<crate::pty::PtyExit>>();
    std::thread::spawn(move || {
        let _ = etx.send(child.wait().ok());
    });
    let sw = s.clone();
    let wait_task = tokio::spawn(async move {
        let status = erx.await.ok().flatten();
        // Give the reader a moment to drain, then drop the master so ConPTY reports EOF.
        tokio::time::sleep(Duration::from_millis(150)).await;
        if let Some(c) = weak_control.upgrade() {
            c.master.lock().unwrap().take();
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), forward).await;
        if sw.channel_open(ch) {
            let (code, signal) = match status {
                Some(st) => (Some(st.code), st.signal),
                None => (None, None),
            };
            sw.send_json(exit_json(ch, code, signal));
            sw.close_channel(ch, None, None);
        }
    });
    s.attach_task(ch, wait_task.abort_handle());
    ok(json!({ "ch": ch, "pid": pid }))
}
