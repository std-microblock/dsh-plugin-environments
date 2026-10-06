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
            self.terminate_with(1);
        }
        pub fn terminate_with(&self, code: u32) {
            unsafe {
                TerminateJobObject(self.0, code);
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

/// How pipe output of a Windows child is turned into the bytes sent to the client
/// (`encoding` of `proc.spawn`; ignored elsewhere and for terminals).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Encoding {
    /// Forward the bytes untouched.
    Raw,
    /// Run the child on a UTF-8 console and transcode leftover code-page text.
    Utf8,
    /// Leave the console code page alone; transcode code-page text to UTF-8.
    Auto,
}

fn encoding(a: &Args<'_>) -> Result<Encoding, OpError> {
    match a.opt_str("encoding") {
        None | Some("utf8") => Ok(Encoding::Utf8),
        Some("auto") => Ok(Encoding::Auto),
        Some("raw") => Ok(Encoding::Raw),
        Some(other) => Err(OpError::invalid(format!(
            "encoding must be raw, utf8 or auto (got {other})"
        ))),
    }
}

/// Hidden subcommand: `dsh-env-server __utf8-console -- <program> <args>...` switches its
/// (inherited, windowless) console to UTF-8 and runs the program on it.
pub const UTF8_TRAMPOLINE: &str = "__utf8-console";

/// Body of [`UTF8_TRAMPOLINE`]; returns the program's exit code.
#[cfg(windows)]
pub fn utf8_trampoline(args: &[std::ffi::OsString]) -> i32 {
    use windows_sys::Win32::System::Console::{SetConsoleCP, SetConsoleOutputCP};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    const CP_UTF8: u32 = 65001;
    let args = match args.first() {
        Some(a) if a == "--" => &args[1..],
        _ => args,
    };
    let Some((program, rest)) = args.split_first() else {
        eprintln!("dsh-env-server: {UTF8_TRAMPOLINE}: missing program");
        return 2;
    };
    unsafe {
        SetConsoleCP(CP_UTF8);
        SetConsoleOutputCP(CP_UTF8);
    }
    // Our own kill-on-close job (nested in the server's once that assigns us) so the
    // program's tree cannot outlive us, whichever happens first.
    let job = job::Job::new().filter(|j| j.assign(unsafe { GetCurrentProcess() }));
    let code = match std::process::Command::new(program).args(rest).status() {
        Ok(st) => st.code().unwrap_or(1),
        Err(e) => {
            eprintln!(
                "dsh-env-server: failed to spawn {}: {e}",
                program.to_string_lossy()
            );
            1
        }
    };
    // Closing a kill-on-close job that contains us while exiting would replace our exit
    // code; end the job (leftover descendants and us) with the program's code instead.
    if let Some(j) = &job {
        j.terminate_with(code as u32);
    }
    code
}

/// Whether `program` can be found the way `CreateProcess` callers usually search.
#[cfg(windows)]
fn program_exists(
    program: &str,
    env: &[(String, Option<String>)],
    clear: bool,
    cwd: &std::path::Path,
) -> bool {
    if program.contains(['/', '\\', ':']) {
        let p = cwd.join(program);
        return p.is_file()
            || [".exe", ".com", ".bat", ".cmd"].iter().any(|e| {
                let mut s = p.clone().into_os_string();
                s.push(e);
                PathBuf::from(s).is_file()
            });
    }
    crate::pty::resolve_program(program, &crate::pty::apply_env(env, clear), cwd) != program
}

/// Resolve the argv for a spawn request.
fn build_argv(a: &Args<'_>, enc: Encoding) -> Result<Vec<String>, OpError> {
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
        // Windows PowerShell pipes strings into native programs as ASCII by default. On
        // its own line so error positions still quote the caller's code (from line 2).
        if cfg!(windows) && enc == Encoding::Utf8 && a.0.get("pty").is_none_or(Value::is_null) {
            prefix.push(format!(
                "try{{$OutputEncoding=[Text.UTF8Encoding]::new($false)}}catch{{}}\n{command}"
            ));
        } else {
            prefix.push(command.to_string());
        }
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
    let enc = encoding(&a)?;
    let argv = build_argv(&a, enc)?;
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
        spawn_pipes(s, argv, cwd, env, clear_env, enc)
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
    enc: Encoding,
) -> OpResult {
    use std::process::Stdio;
    #[cfg(windows)]
    let program = if enc == Encoding::Utf8 {
        // The console code page can only be set from inside the child's console, so a
        // copy of ourselves sets it and runs the program there.
        if !program_exists(&argv[0], &env, clear_env, &cwd) {
            return Err(OpError::new(
                "ENOENT",
                format!("failed to spawn {}: program not found", argv[0]),
            ));
        }
        std::env::current_exe().ok()
    } else {
        None
    };
    #[cfg(not(windows))]
    let program: Option<PathBuf> = {
        let _ = enc;
        None
    };
    let mut cmd = match &program {
        Some(exe) => {
            let mut c = tokio::process::Command::new(exe);
            c.args([UTF8_TRAMPOLINE, "--"]).args(&argv);
            c
        }
        None => {
            let mut c = tokio::process::Command::new(&argv[0]);
            c.args(&argv[1..]);
            c
        }
    };
    cmd.current_dir(&cwd)
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
        enc: Encoding,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            #[cfg(windows)]
            let mut decoder = (enc != Encoding::Raw)
                .then(|| crate::util::codepage::StreamDecoder::new(crate::util::codepage::oem()));
            #[cfg(not(windows))]
            let _ = enc;
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match r.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        #[cfg(windows)]
                        let data = match &mut decoder {
                            Some(d) => d.push(&buf[..n]),
                            None => buf[..n].to_vec(),
                        };
                        #[cfg(not(windows))]
                        let data = buf[..n].to_vec();
                        if !data.is_empty() && !s.send_data(ch, Some(fd), data).await {
                            return;
                        }
                    }
                }
            }
            #[cfg(windows)]
            if let Some(d) = &mut decoder {
                let rest = d.finish();
                if !rest.is_empty() && !s.send_data(ch, Some(fd), rest).await {
                    return;
                }
            }
            s.send_eof(ch, Some(fd));
        })
    }

    let out_task = stdout.map(|o| pump(s.clone(), ch, 1, o, enc));
    let err_task = stderr.map(|e| pump(s.clone(), ch, 2, e, enc));
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
