//! Pseudo-terminal support.
//!
//! * Unix: `openpty(3)` + fork/exec through `std::process::Command` with a
//!   `pre_exec` hook that makes the child a session leader owning the slave as its
//!   controlling terminal.
//! * Windows: ConPTY (`CreatePseudoConsole`) with the child created suspended so it
//!   can be put into a job object before it runs.
//!
//! This is deliberately not `portable-pty` (evaluated again; see
//! docs/building-server.md "PTY"): it cannot create the Windows child suspended (so a
//! job object can only be assigned after the child already runs), loads ConPTY with
//! an `expect()` (a panic, i.e. a silent abort of the whole server in the
//! immediate-abort build, where ConPTY is missing) and prefers a `conpty.dll` found on
//! the DLL search path, allocates between `fork` and `exec` on Unix (its
//! `close_random_fds` reads `/dev/fd`, unsafe in our multi-threaded process), and
//! only offers SIGHUP to the child pid, not signals to the process group.

use std::ffi::OsString;
use std::io;
use std::path::PathBuf;

/// What to run inside the terminal.
pub struct PtyCommand {
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    /// Applied in order on top of the inherited (or cleared) environment;
    /// `None` removes the variable.
    pub env: Vec<(String, Option<String>)>,
    pub clear_env: bool,
}

/// Exit status of a terminal child.
#[derive(Debug, Clone, PartialEq)]
pub struct PtyExit {
    pub code: i32,
    pub signal: Option<String>,
}

#[cfg(unix)]
pub use unix::*;
#[cfg(windows)]
pub use windows::*;

/// Build the child's environment: inherited (unless cleared) plus ordered edits.
fn effective_env(cmd: &PtyCommand) -> Vec<(OsString, OsString)> {
    apply_env(&cmd.env, cmd.clear_env)
}

/// The inherited (unless `clear`) environment with ordered edits applied.
pub(crate) fn apply_env(
    edits: &[(String, Option<String>)],
    clear: bool,
) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = if clear {
        Vec::new()
    } else {
        std::env::vars_os().collect()
    };
    let same = |a: &OsString, b: &str| {
        if cfg!(windows) {
            a.to_string_lossy().eq_ignore_ascii_case(b)
        } else {
            a.as_os_str() == b
        }
    };
    for (k, v) in edits {
        env.retain(|(ek, _)| !same(ek, k));
        if let Some(v) = v {
            env.push((k.into(), v.into()));
        }
    }
    env
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::fs::File;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    use std::process::{Command, Stdio};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn cvt(r: libc::c_int) -> io::Result<libc::c_int> {
        if r == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(r)
        }
    }

    fn winsize(rows: u16, cols: u16) -> libc::winsize {
        libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        }
    }

    fn set_cloexec(fd: libc::c_int) -> io::Result<()> {
        unsafe {
            let flags = cvt(libc::fcntl(fd, libc::F_GETFD))?;
            cvt(libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC))?;
        }
        Ok(())
    }

    /// The controlling side of the terminal.
    pub struct PtyMaster {
        fd: OwnedFd,
    }

    impl PtyMaster {
        pub fn reader(&self) -> io::Result<File> {
            Ok(File::from(self.fd.try_clone()?))
        }
        pub fn writer(&self) -> io::Result<File> {
            Ok(File::from(self.fd.try_clone()?))
        }
        pub fn resize(&self, rows: u16, cols: u16) -> io::Result<()> {
            let ws = winsize(rows, cols);
            cvt(unsafe { libc::ioctl(self.fd.as_raw_fd(), libc::TIOCSWINSZ as _, &ws) })?;
            Ok(())
        }
        pub fn size(&self) -> io::Result<(u16, u16)> {
            let mut ws = winsize(0, 0);
            cvt(unsafe { libc::ioctl(self.fd.as_raw_fd(), libc::TIOCGWINSZ as _, &mut ws) })?;
            Ok((ws.ws_row, ws.ws_col))
        }
    }

    /// Signals the child's process group (the child is a session leader).
    #[derive(Clone)]
    pub struct PtyKiller {
        pid: libc::pid_t,
        exited: Arc<AtomicBool>,
    }

    impl PtyKiller {
        /// `TERM`/`INT`/`HUP`/`QUIT` send that signal; anything else (default `KILL`)
        /// sends SIGHUP like a closing terminal, then SIGKILL shortly after.
        pub fn kill(&self, signal: &str) {
            if self.exited.load(Ordering::SeqCst) {
                return;
            }
            let send = |sig| unsafe {
                if libc::killpg(self.pid, sig) != 0 {
                    libc::kill(self.pid, sig);
                }
            };
            match signal {
                "TERM" => send(libc::SIGTERM),
                "INT" => send(libc::SIGINT),
                "HUP" => send(libc::SIGHUP),
                "QUIT" => send(libc::SIGQUIT),
                _ => {
                    send(libc::SIGHUP);
                    let k = self.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        if !k.exited.load(Ordering::SeqCst) {
                            unsafe {
                                if libc::killpg(k.pid, libc::SIGKILL) != 0 {
                                    libc::kill(k.pid, libc::SIGKILL);
                                }
                            }
                        }
                    });
                }
            }
        }
    }

    pub struct PtyChild {
        child: std::process::Child,
        exited: Arc<AtomicBool>,
    }

    impl PtyChild {
        pub fn pid(&self) -> u32 {
            self.child.id()
        }
        pub fn killer(&self) -> PtyKiller {
            PtyKiller {
                pid: self.child.id() as libc::pid_t,
                exited: self.exited.clone(),
            }
        }
        /// Block until the child exits.
        pub fn wait(mut self) -> io::Result<PtyExit> {
            let st = self.child.wait();
            self.exited.store(true, Ordering::SeqCst);
            let st = st?;
            Ok(match st.signal() {
                Some(sig) => PtyExit {
                    code: 1,
                    signal: Some(format!("SIG{sig}")),
                },
                None => PtyExit {
                    code: st.code().unwrap_or(1),
                    signal: None,
                },
            })
        }
    }

    pub fn spawn(cmd: &PtyCommand, rows: u16, cols: u16) -> io::Result<(PtyMaster, PtyChild)> {
        let mut master: libc::c_int = -1;
        let mut slave: libc::c_int = -1;
        let mut ws = winsize(rows, cols);
        cvt(unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                // `*const` on Linux, `*mut` on macOS.
                &raw mut ws,
            )
        })?;
        let master = unsafe { OwnedFd::from_raw_fd(master) };
        let slave = unsafe { OwnedFd::from_raw_fd(slave) };
        set_cloexec(master.as_raw_fd())?;
        set_cloexec(slave.as_raw_fd())?;

        let mut c = Command::new(&cmd.argv[0]);
        c.args(&cmd.argv[1..]).current_dir(&cmd.cwd);
        c.env_clear();
        c.envs(effective_env(cmd));
        c.stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
            .stderr(Stdio::from(slave.try_clone()?));
        unsafe {
            c.pre_exec(|| {
                // New session; the slave (now fd 0) becomes the controlling terminal.
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = c.spawn()?;
        drop(slave);
        Ok((
            PtyMaster { fd: master },
            PtyChild {
                child,
                exited: Arc::new(AtomicBool::new(false)),
            },
        ))
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::fs::File;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use std::ptr::{null, null_mut};
    use std::sync::Arc;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Console::{
        COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
    };
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::*;

    struct Hpc(HPCON);
    unsafe impl Send for Hpc {}
    unsafe impl Sync for Hpc {}

    /// The controlling side of the terminal.
    pub struct PtyMaster {
        hpc: Hpc,
        input: OwnedHandle,
        output: OwnedHandle,
    }

    impl PtyMaster {
        pub fn reader(&self) -> io::Result<File> {
            Ok(File::from(self.output.try_clone()?))
        }
        pub fn writer(&self) -> io::Result<File> {
            Ok(File::from(self.input.try_clone()?))
        }
        pub fn resize(&self, rows: u16, cols: u16) -> io::Result<()> {
            let hr = unsafe {
                ResizePseudoConsole(
                    self.hpc.0,
                    COORD {
                        X: cols as i16,
                        Y: rows as i16,
                    },
                )
            };
            if hr < 0 {
                Err(io::Error::from_raw_os_error(hr))
            } else {
                Ok(())
            }
        }
    }

    impl Drop for PtyMaster {
        fn drop(&mut self) {
            // ClosePseudoConsole can block until the output pipe is drained (older
            // Windows builds); never do that on the async runtime thread.
            let hpc = Hpc(self.hpc.0);
            std::thread::spawn(move || unsafe {
                let hpc = hpc;
                ClosePseudoConsole(hpc.0);
            });
        }
    }

    struct ProcHandle(HANDLE);
    unsafe impl Send for ProcHandle {}
    unsafe impl Sync for ProcHandle {}
    impl Drop for ProcHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    #[derive(Clone)]
    pub struct PtyKiller(Arc<ProcHandle>);

    impl PtyKiller {
        pub fn kill(&self, _signal: &str) {
            unsafe {
                TerminateProcess(self.0.0, 1);
            }
        }
    }

    pub struct PtyChild {
        pid: u32,
        process: Arc<ProcHandle>,
    }

    impl PtyChild {
        pub fn pid(&self) -> u32 {
            self.pid
        }
        pub fn killer(&self) -> PtyKiller {
            PtyKiller(self.process.clone())
        }
        pub fn wait(self) -> io::Result<PtyExit> {
            unsafe {
                if WaitForSingleObject(self.process.0, INFINITE) != 0 {
                    return Err(io::Error::last_os_error());
                }
                let mut code = 0u32;
                if GetExitCodeProcess(self.process.0, &mut code) == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(PtyExit {
                    code: code as i32,
                    signal: None,
                })
            }
        }
    }

    /// Quote one argument for the MSVC command-line parser.
    pub fn quote_arg(arg: &str, out: &mut String) {
        if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
            out.push_str(arg);
            return;
        }
        out.push('"');
        let mut backslashes = 0;
        for c in arg.chars() {
            match c {
                '\\' => backslashes += 1,
                '"' => {
                    out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                    out.push('"');
                    backslashes = 0;
                }
                _ => {
                    out.extend(std::iter::repeat_n('\\', backslashes));
                    out.push(c);
                    backslashes = 0;
                }
            }
        }
        out.extend(std::iter::repeat_n('\\', backslashes * 2));
        out.push('"');
    }

    /// Resolve a bare program name through PATH / PATHEXT of the child environment.
    pub fn resolve_program(
        name: &str,
        env: &[(OsString, OsString)],
        cwd: &std::path::Path,
    ) -> String {
        if name.contains(['/', '\\', ':']) {
            return name.to_string();
        }
        let get = |k: &str| {
            env.iter()
                .find(|(ek, _)| ek.to_string_lossy().eq_ignore_ascii_case(k))
                .map(|(_, v)| v.clone())
        };
        let exts: Vec<String> = get("PATHEXT")
            .map(|v| v.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        let has_ext = std::path::Path::new(name).extension().is_some();
        let mut dirs = vec![cwd.to_path_buf()];
        if let Some(path) = get("PATH").or_else(|| std::env::var_os("PATH")) {
            dirs.extend(std::env::split_paths(&path));
        }
        for dir in dirs {
            if has_ext {
                let c = dir.join(name);
                if c.is_file() {
                    return c.to_string_lossy().into_owned();
                }
            }
            for ext in &exts {
                let c = dir.join(format!("{name}{ext}"));
                if c.is_file() {
                    return c.to_string_lossy().into_owned();
                }
            }
        }
        name.to_string()
    }

    fn env_block(env: &mut [(OsString, OsString)]) -> Vec<u16> {
        env.sort_by_key(|a| a.0.to_string_lossy().to_uppercase());
        let mut block = Vec::new();
        for (k, v) in env.iter() {
            block.extend(k.encode_wide());
            block.push('=' as u16);
            block.extend(v.encode_wide());
            block.push(0);
        }
        if block.is_empty() {
            block.push(0);
        }
        block.push(0);
        block
    }

    fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
        let mut r: HANDLE = null_mut();
        let mut w: HANDLE = null_mut();
        if unsafe { CreatePipe(&mut r, &mut w, null(), 0) } == 0 {
            return Err(io::Error::last_os_error());
        }
        unsafe {
            Ok((
                OwnedHandle::from_raw_handle(r as _),
                OwnedHandle::from_raw_handle(w as _),
            ))
        }
    }

    pub fn spawn(
        cmd: &PtyCommand,
        rows: u16,
        cols: u16,
        job: Option<&crate::proc::job::Job>,
    ) -> io::Result<(PtyMaster, PtyChild)> {
        use std::os::windows::io::AsRawHandle;
        let (in_read, in_write) = pipe()?;
        let (out_read, out_write) = pipe()?;
        let mut hpc: HPCON = unsafe { zeroed() };
        let hr = unsafe {
            CreatePseudoConsole(
                COORD {
                    X: cols as i16,
                    Y: rows as i16,
                },
                in_read.as_raw_handle() as HANDLE,
                out_write.as_raw_handle() as HANDLE,
                0,
                &mut hpc,
            )
        };
        if hr < 0 {
            return Err(io::Error::from_raw_os_error(hr));
        }
        // ConPTY duplicated its ends.
        drop(in_read);
        drop(out_write);
        let master = PtyMaster {
            hpc: Hpc(hpc),
            input: in_write,
            output: out_read,
        };

        let mut env = effective_env(cmd);
        let program = resolve_program(&cmd.argv[0], &env, &cmd.cwd);
        let mut cmdline = String::new();
        quote_arg(&program, &mut cmdline);
        for a in &cmd.argv[1..] {
            cmdline.push(' ');
            quote_arg(a, &mut cmdline);
        }
        let mut wcmd: Vec<u16> = cmdline.encode_utf16().chain(Some(0)).collect();
        let wcwd: Vec<u16> = cmd.cwd.as_os_str().encode_wide().chain(Some(0)).collect();
        let block = env_block(&mut env);

        unsafe {
            let mut size = 0usize;
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
            let mut attrs = vec![0u8; size];
            let list = attrs.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
            if InitializeProcThreadAttributeList(list, 1, 0, &mut size) == 0 {
                return Err(io::Error::last_os_error());
            }
            struct ListGuard(LPPROC_THREAD_ATTRIBUTE_LIST);
            impl Drop for ListGuard {
                fn drop(&mut self) {
                    unsafe { DeleteProcThreadAttributeList(self.0) }
                }
            }
            let _guard = ListGuard(list);
            if UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                hpc as _,
                size_of::<HPCON>(),
                null_mut(),
                null(),
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let mut si: STARTUPINFOEXW = zeroed();
            si.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
            // Don't let the child pick up our (redirected) std handles instead of the PTY.
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            si.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
            si.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
            si.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
            si.lpAttributeList = list;
            let mut pi: PROCESS_INFORMATION = zeroed();
            let ok = CreateProcessW(
                null(),
                wcmd.as_mut_ptr(),
                null(),
                null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                block.as_ptr() as _,
                wcwd.as_ptr(),
                &si.StartupInfo,
                &mut pi,
            );
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            if let Some(j) = job {
                j.assign(pi.hProcess);
            }
            ResumeThread(pi.hThread);
            CloseHandle(pi.hThread);
            Ok((
                master,
                PtyChild {
                    pid: pi.dwProcessId,
                    process: Arc::new(ProcHandle(pi.hProcess)),
                },
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// Collects terminal output on a thread; answers ConPTY's cursor query.
    fn collect(master: &PtyMaster) -> mpsc::Receiver<Vec<u8>> {
        let mut r = master.reader().unwrap();
        let mut w = master.writer().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = r.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if buf[..n].windows(4).any(|x| x == b"\x1b[6n") {
                    let _ = w.write_all(b"\x1b[1;1R");
                }
                if tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        rx
    }

    fn wait_for(rx: &mpsc::Receiver<Vec<u8>>, acc: &mut Vec<u8>, needle: &str, secs: u64) -> bool {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < deadline {
            if String::from_utf8_lossy(acc).contains(needle) {
                return true;
            }
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                acc.extend(chunk);
            }
        }
        String::from_utf8_lossy(acc).contains(needle)
    }

    fn cmd(script: &str) -> PtyCommand {
        #[cfg(unix)]
        let argv = vec!["/bin/sh".to_string(), "-c".to_string(), script.to_string()];
        #[cfg(windows)]
        let argv = vec![
            "cmd.exe".to_string(),
            "/d".to_string(),
            "/c".to_string(),
            script.to_string(),
        ];
        PtyCommand {
            argv,
            cwd: std::env::temp_dir(),
            env: vec![
                ("DSH_PTY_TEST".into(), Some("hello-env".into())),
                ("DSH_PTY_GONE".into(), None),
            ],
            clear_env: false,
        }
    }

    fn spawn_cmd(c: &PtyCommand, rows: u16, cols: u16) -> (PtyMaster, PtyChild) {
        #[cfg(unix)]
        return spawn(c, rows, cols).unwrap();
        #[cfg(windows)]
        return spawn(c, rows, cols, None).unwrap();
    }

    #[test]
    fn runs_with_env_and_exit_code() {
        #[cfg(unix)]
        let c = cmd("echo out:$DSH_PTY_TEST; [ -t 0 ] && echo is-tty; exit 7");
        #[cfg(windows)]
        let c = cmd("echo out:%DSH_PTY_TEST% & exit /b 7");
        let (master, child) = spawn_cmd(&c, 24, 80);
        assert!(child.pid() > 0);
        let rx = collect(&master);
        let st = child.wait().unwrap();
        assert_eq!(st.code, 7);
        let mut acc = Vec::new();
        assert!(
            wait_for(&rx, &mut acc, "out:hello-env", 5),
            "output: {:?}",
            String::from_utf8_lossy(&acc)
        );
        #[cfg(unix)]
        assert!(wait_for(&rx, &mut acc, "is-tty", 5));
        drop(master);
    }

    #[test]
    fn input_and_kill() {
        #[cfg(unix)]
        let c = cmd("read line; echo got:$line; sleep 30");
        #[cfg(windows)]
        let c = cmd("set /p line=& call echo got:%line% & ping -n 30 127.0.0.1 >nul");
        let (master, child) = spawn_cmd(&c, 24, 80);
        let rx = collect(&master);
        let mut w = master.writer().unwrap();
        w.write_all(b"abc\r").unwrap();
        let mut acc = Vec::new();
        assert!(
            wait_for(&rx, &mut acc, "got:abc", 10),
            "output: {:?}",
            String::from_utf8_lossy(&acc)
        );
        let killer = child.killer();
        let t = Instant::now();
        killer.kill("KILL");
        let st = child.wait().unwrap();
        assert!(t.elapsed() < Duration::from_secs(5));
        #[cfg(unix)]
        assert!(st.signal.is_some());
        #[cfg(windows)]
        assert_eq!(st.code, 1);
        drop(master);
    }

    #[test]
    fn resize_applies() {
        #[cfg(unix)]
        {
            let c = cmd("sleep 1; stty size");
            let (master, child) = spawn_cmd(&c, 24, 80);
            assert_eq!(master.size().unwrap(), (24, 80));
            master.resize(33, 101).unwrap();
            assert_eq!(master.size().unwrap(), (33, 101));
            let rx = collect(&master);
            let mut acc = Vec::new();
            assert!(
                wait_for(&rx, &mut acc, "33 101", 10),
                "output: {:?}",
                String::from_utf8_lossy(&acc)
            );
            child.wait().unwrap();
        }
        #[cfg(windows)]
        {
            let c = cmd("ping -n 3 127.0.0.1 >nul & mode con");
            let (master, child) = spawn_cmd(&c, 24, 80);
            let rx = collect(&master);
            master.resize(30, 101).unwrap();
            let mut acc = Vec::new();
            assert!(
                wait_for(&rx, &mut acc, "101", 20),
                "output: {:?}",
                String::from_utf8_lossy(&acc)
            );
            child.wait().unwrap();
        }
    }

    #[test]
    fn missing_program_fails() {
        let c = PtyCommand {
            argv: vec!["dsh-definitely-not-a-program-xyz".into()],
            cwd: std::env::temp_dir(),
            env: vec![],
            clear_env: false,
        };
        #[cfg(unix)]
        assert!(spawn(&c, 24, 80).is_err());
        #[cfg(windows)]
        assert!(spawn(&c, 24, 80, None).is_err());
    }
}
