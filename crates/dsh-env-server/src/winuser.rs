//! Management of dsh-managed local Windows accounts.

#[cfg(windows)]
mod imp {
    use super::{Result, bail};
    use serde_json::json;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree};
    use windows_sys::Win32::NetworkManagement::NetManagement::*;
    use windows_sys::Win32::Security::Cryptography::*;
    use windows_sys::Win32::System::Threading::*;

    pub const COMMENT: &str = "dsh-env managed";

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    unsafe fn from_wide(p: *const u16) -> String {
        if p.is_null() {
            return String::new();
        }
        let mut len = 0;
        unsafe {
            while *p.add(len) != 0 {
                len += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
        }
    }

    fn random_password() -> String {
        const SETS: [&[u8]; 4] = [
            b"ABCDEFGHJKLMNPQRSTUVWXYZ",
            b"abcdefghijkmnopqrstuvwxyz",
            b"23456789",
            b"!#%+-=?@_",
        ];
        let mut out = Vec::new();
        for set in SETS {
            for _ in 0..5 {
                out.push(set[crate::util::random_u32() as usize % set.len()]);
            }
        }
        // Fisher-Yates shuffle
        for i in (1..out.len()).rev() {
            let j = crate::util::random_u32() as usize % (i + 1);
            out.swap(i, j);
        }
        String::from_utf8(out).unwrap()
    }

    fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>> {
        unsafe {
            let input = CRYPT_INTEGER_BLOB {
                cbData: data.len() as u32,
                pbData: data.as_ptr() as *mut u8,
            };
            let mut output = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: null_mut(),
            };
            if CryptProtectData(
                &input,
                null(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            ) == 0
            {
                bail!(
                    "CryptProtectData failed: {}",
                    std::io::Error::last_os_error()
                );
            }
            let v = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            LocalFree(output.pbData as _);
            Ok(v)
        }
    }

    fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>> {
        unsafe {
            let input = CRYPT_INTEGER_BLOB {
                cbData: data.len() as u32,
                pbData: data.as_ptr() as *mut u8,
            };
            let mut output = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: null_mut(),
            };
            if CryptUnprotectData(
                &input,
                null_mut(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            ) == 0
            {
                bail!(
                    "CryptUnprotectData failed: {}",
                    std::io::Error::last_os_error()
                );
            }
            let v = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            LocalFree(output.pbData as _);
            Ok(v)
        }
    }

    /// String form (`S-1-5-21-...`) of the account's SID.
    pub fn account_sid(name: &str) -> Option<String> {
        use windows_sys::Win32::Security::*;
        let wname = wide(name);
        let mut sid_len = 0u32;
        let mut dom_len = 0u32;
        let mut kind: SID_NAME_USE = 0;
        unsafe {
            LookupAccountNameW(
                null(),
                wname.as_ptr(),
                null_mut(),
                &mut sid_len,
                null_mut(),
                &mut dom_len,
                &mut kind,
            );
            if sid_len == 0 {
                return None;
            }
            let mut sid = vec![0u8; sid_len as usize];
            let mut dom = vec![0u16; dom_len.max(1) as usize];
            if LookupAccountNameW(
                null(),
                wname.as_ptr(),
                sid.as_mut_ptr() as PSID,
                &mut sid_len,
                dom.as_mut_ptr(),
                &mut dom_len,
                &mut kind,
            ) == 0
            {
                return None;
            }
            let psid = sid.as_mut_ptr() as PSID;
            let auth = (*GetSidIdentifierAuthority(psid)).Value;
            let auth = auth.iter().fold(0u64, |a, &b| (a << 8) | b as u64);
            let mut s = format!("S-1-{auth}");
            for i in 0..*GetSidSubAuthorityCount(psid) as u32 {
                s.push_str(&format!("-{}", *GetSidSubAuthority(psid, i)));
            }
            Some(s)
        }
    }

    /// The registered profile directory of a SID (absent before the first logon). New
    /// accounts whose name clashes with a leftover folder get e.g. `C:\Users\name.HOST`.
    pub fn profile_path(sid: &str) -> Option<PathBuf> {
        use windows_sys::Win32::System::Registry::*;
        let key = wide(&format!(
            "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\{sid}"
        ));
        let value = wide("ProfileImagePath");
        let mut buf = vec![0u16; 1024];
        let mut len = (buf.len() * 2) as u32;
        let rc = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                null_mut(),
                buf.as_mut_ptr() as _,
                &mut len,
            )
        };
        if rc != 0 {
            return None;
        }
        // The reported size is not reliable for expanded REG_EXPAND_SZ values.
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        buf.truncate(end.min(len as usize / 2));
        Some(PathBuf::from(String::from_utf16_lossy(&buf)))
    }

    #[link(name = "userenv", kind = "raw-dylib")]
    unsafe extern "system" {
        fn DeleteProfileW(sid: *const u16, path: *const u16, computer: *const u16) -> i32;
    }

    /// Run a console tool, returning (success, decoded output).
    fn tool(program: &str, args: &[&str]) -> Result<(bool, String)> {
        let out = std::process::Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("{program}: {e}"))?;
        let cp = crate::util::codepage::oem();
        let mut text = crate::util::codepage::decode_any(cp, &out.stdout);
        text.push_str(&crate::util::codepage::decode_any(cp, &out.stderr));
        Ok((out.status.success(), text.trim().to_string()))
    }

    pub fn create(name: &str, secret_out: &str) -> Result<serde_json::Value> {
        let password = random_password();
        let mut wname = wide(name);
        let mut wpass = wide(&password);
        let mut wcomment = wide(COMMENT);
        let info = USER_INFO_1 {
            usri1_name: wname.as_mut_ptr(),
            usri1_password: wpass.as_mut_ptr(),
            usri1_password_age: 0,
            usri1_priv: USER_PRIV_USER,
            usri1_home_dir: null_mut(),
            usri1_comment: wcomment.as_mut_ptr(),
            usri1_flags: UF_SCRIPT | UF_DONT_EXPIRE_PASSWD,
            usri1_script_path: null_mut(),
        };
        let mut parm_err = 0u32;
        let rc = unsafe { NetUserAdd(null(), 1, &info as *const _ as *const u8, &mut parm_err) };
        if rc != 0 {
            if rc == 5 {
                bail!("NetUserAdd failed: access denied (administrator rights are required)");
            }
            if rc == NERR_UserExists {
                bail!("a user named `{name}` already exists");
            }
            bail!("NetUserAdd failed with code {rc} (parameter {parm_err})");
        }
        let protected = dpapi_protect(password.as_bytes())?;
        let encoded = crate::util::base64_encode(&protected);
        std::fs::write(secret_out, encoded).map_err(|e| format!("writing {secret_out}: {e}"))?;
        Ok(json!({"ok": true, "name": name}))
    }

    pub fn list() -> Result<serde_json::Value> {
        let mut out = Vec::new();
        let mut resume = 0u32;
        loop {
            let mut buf: *mut u8 = null_mut();
            let mut read = 0u32;
            let mut total = 0u32;
            let rc = unsafe {
                NetUserEnum(
                    null(),
                    1,
                    FILTER_NORMAL_ACCOUNT,
                    &mut buf,
                    MAX_PREFERRED_LENGTH,
                    &mut read,
                    &mut total,
                    &mut resume,
                )
            };
            if rc != 0 && rc != 234 {
                bail!("NetUserEnum failed with code {rc}");
            }
            unsafe {
                let items = std::slice::from_raw_parts(buf as *const USER_INFO_1, read as usize);
                for item in items {
                    let comment = from_wide(item.usri1_comment);
                    if comment == COMMENT {
                        let name = from_wide(item.usri1_name);
                        let sid = account_sid(&name);
                        let profile = sid.as_deref().and_then(profile_path);
                        out.push(json!({
                            "name": name,
                            "sid": sid,
                            "profile": profile.as_ref().map(|p| p.to_string_lossy()),
                            "profileExists": profile.is_some_and(|p| p.is_dir()),
                        }));
                    }
                }
                if !buf.is_null() {
                    NetApiBufferFree(buf as _);
                }
            }
            if rc != 234 {
                break;
            }
        }
        Ok(serde_json::Value::Array(out))
    }

    pub fn delete(name: &str, purge: bool) -> Result<serde_json::Value> {
        let managed = list()?.as_array().cloned().unwrap_or_default();
        if !managed.iter().any(|u| {
            u["name"]
                .as_str()
                .map(|n| n.eq_ignore_ascii_case(name))
                .unwrap_or(false)
        }) {
            bail!("`{name}` is not a dsh-managed account");
        }
        let sid = account_sid(name);
        // Processes still running as the account keep its profile loaded (and the
        // account's files open); end them first.
        let _ = tool(
            "taskkill.exe",
            &["/F", "/T", "/FI", &format!("USERNAME eq {name}")],
        );
        let wname = wide(name);
        let rc = unsafe { NetUserDel(null(), wname.as_ptr()) };
        if rc != 0 {
            bail!("NetUserDel failed with code {rc}");
        }
        let mut result = json!({"ok": true, "name": name});
        if purge && let Some(sid) = sid {
            let path = profile_path(&sid);
            let wsid = wide(&sid);
            // The profile service unloads the hive a little after the last process ends.
            let mut error = None;
            for _ in 0..20 {
                let deleted = unsafe { DeleteProfileW(wsid.as_ptr(), null(), null()) } != 0;
                let e = std::io::Error::last_os_error();
                if deleted || profile_path(&sid).is_none() {
                    error = None;
                    break;
                }
                error = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(750));
            }
            if let Some(p) = &path
                && p.exists()
            {
                let _ = std::fs::remove_dir_all(p);
            }
            let left = path.as_ref().is_some_and(|p| p.exists()) || profile_path(&sid).is_some();
            result["profile"] = json!(path.as_ref().map(|p| p.to_string_lossy()));
            result["profileRemoved"] = json!(!left);
            if left {
                result["warning"] = json!(format!(
                    "the account was deleted but its profile {} could not be removed{}",
                    path.as_ref()
                        .map(|p| p.display().to_string())
                        .unwrap_or_default(),
                    error.map(|e| format!(": {e}")).unwrap_or_default()
                ));
            }
        }
        Ok(result)
    }

    pub fn grant(name: &str, path: &str) -> Result<serde_json::Value> {
        // Inheritable ACE on the directory; Windows propagates it to the existing tree.
        let (ok, out) = tool(
            "icacls.exe",
            &[path, "/grant", &format!("{name}:(OI)(CI)M"), "/Q"],
        )?;
        if !ok {
            bail!("icacls failed: {out}");
        }
        Ok(json!({"ok": true}))
    }

    fn quote_arg(arg: &str) -> String {
        if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
            return arg.to_string();
        }
        let mut out = String::from("\"");
        let mut backslashes = 0;
        for c in arg.chars() {
            match c {
                '\\' => backslashes += 1,
                '"' => {
                    out.push_str(&"\\".repeat(backslashes * 2 + 1));
                    out.push('"');
                    backslashes = 0;
                }
                _ => {
                    out.push_str(&"\\".repeat(backslashes));
                    out.push(c);
                    backslashes = 0;
                }
            }
        }
        out.push_str(&"\\".repeat(backslashes * 2));
        out.push('"');
        out
    }

    /// Explain the CreateProcessWithLogonW failures users actually hit.
    fn logon_hint(code: Option<i32>) -> &'static str {
        match code {
            Some(1326) => {
                " (the stored password no longer matches; delete and recreate the account)"
            }
            Some(1327) | Some(1331) => " (the account is disabled or restricted)",
            Some(1385) => {
                " (local policy does not allow this account to log on locally; check \"Allow log on locally\" / \"Deny log on locally\")"
            }
            Some(267) => " (the working directory does not exist or the account cannot open it)",
            Some(1058) | Some(1079) => {
                " (the Secondary Logon service \"seclogon\" is disabled; enable it in services.msc)"
            }
            Some(5) => {
                " (access denied: the account cannot execute the program; grant it read & execute)"
            }
            _ => "",
        }
    }

    /// Start `program` as the account on the interactive desktop.
    ///
    /// The process is created suspended and put into a kill-on-close job owned by this
    /// launcher. With `supervise`, the launcher prints the result line, then stays alive
    /// until the process exits or its stdin closes (the plugin went away or closed the
    /// environment) and takes the whole tree down with it, so nothing started as the
    /// account outlives the connection. Without it the process is detached as before.
    pub fn launch(
        name: &str,
        secret_file: &str,
        cwd: Option<&str>,
        program: &[String],
        supervise: bool,
    ) -> Result<serde_json::Value> {
        use std::io::Write;
        if program.is_empty() {
            bail!("missing program");
        }
        let encoded = std::fs::read_to_string(secret_file)
            .map_err(|e| format!("reading {secret_file}: {e}"))?;
        let protected = crate::util::base64_decode(encoded.trim())?;
        let password =
            String::from_utf8(dpapi_unprotect(&protected)?).map_err(|e| e.to_string())?;
        let cmdline = program
            .iter()
            .map(|a| quote_arg(a))
            .collect::<Vec<_>>()
            .join(" ");
        let mut wcmd = wide(&cmdline);
        let wuser = wide(name);
        let wdomain = wide(".");
        let wpass = wide(&password);
        let wcwd = cwd.map(wide);
        // Kill-on-close: only meaningful while we stay around to hold it.
        let job = if supervise {
            crate::proc::job::Job::new()
        } else {
            None
        };
        unsafe {
            let mut si: STARTUPINFOW = std::mem::zeroed();
            si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            // A null desktop makes the secondary logon service use the caller's window
            // station/desktop (WinSta0\Default) AND grant the account's logon SID access to
            // it, so GUI programs started by the account show up on the user's desktop.
            si.lpDesktop = null_mut();
            si.dwFlags = STARTF_USESHOWWINDOW;
            si.wShowWindow = 0; // SW_HIDE, should a console window be created anyway
            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
            let mut create = |flags: PROCESS_CREATION_FLAGS| {
                CreateProcessWithLogonW(
                    wuser.as_ptr(),
                    wdomain.as_ptr(),
                    wpass.as_ptr(),
                    // Loads the profile (creating it on the first logon) so USERPROFILE,
                    // APPDATA, HKCU, ... are the account's own.
                    LOGON_WITH_PROFILE,
                    null(),
                    wcmd.as_mut_ptr(),
                    // A null environment means "built from the account's profile".
                    flags | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                    null(),
                    wcwd.as_ref().map(|w| w.as_ptr()).unwrap_or(null()),
                    &si,
                    &mut pi,
                ) != 0
            };
            // A windowless console (no flash, no Windows Terminal tab); fall back to a
            // hidden new console where the flag is not accepted.
            if !create(CREATE_NO_WINDOW) && !create(CREATE_NEW_CONSOLE) {
                let e = std::io::Error::last_os_error();
                bail!(
                    "CreateProcessWithLogonW failed: {e}{}",
                    logon_hint(e.raw_os_error())
                );
            }
            let in_job = job.as_ref().is_some_and(|j| j.assign(pi.hProcess));
            ResumeThread(pi.hThread);
            CloseHandle(pi.hThread);
            let pid = pi.dwProcessId;
            // Report an immediate failure (e.g. 0xC0000142 when the account cannot reach the desktop).
            if WaitForSingleObject(pi.hProcess, 1500) == 0 {
                let mut code = 0u32;
                GetExitCodeProcess(pi.hProcess, &mut code);
                CloseHandle(pi.hProcess);
                let hint = match code {
                    0xC000_0142 => {
                        " (DLL initialization failed: the account cannot access the window station/desktop)"
                    }
                    0xC000_0022 => " (access denied: the account cannot execute the program)",
                    _ => "",
                };
                return Ok(json!({
                    "ok": false,
                    "pid": pid,
                    "exitCode": code,
                    "error": format!("the process exited immediately with code 0x{code:08X}{hint}"),
                }));
            }
            let started = json!({"ok": true, "pid": pid, "job": in_job});
            if !supervise {
                CloseHandle(pi.hProcess);
                return Ok(started);
            }
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{started}");
            let _ = out.flush();
            // stdin closing (or failing) ends the supervision.
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            std::thread::spawn(move || {
                let mut buf = [0u8; 256];
                while let Ok(n) = std::io::Read::read(&mut std::io::stdin(), &mut buf) {
                    if n == 0 {
                        break;
                    }
                }
                let _ = tx.send(());
            });
            let mut exit = None;
            loop {
                if WaitForSingleObject(pi.hProcess, 200) == 0 {
                    let mut code = 0u32;
                    GetExitCodeProcess(pi.hProcess, &mut code);
                    exit = Some(code);
                    break;
                }
                if rx.try_recv().is_ok() {
                    break;
                }
            }
            if let Some(j) = &job {
                j.terminate();
            }
            CloseHandle(pi.hProcess);
            Ok(json!({"ok": true, "pid": pid, "exited": exit}))
        }
    }
}

/// Error type for winuser commands (message only).
#[cfg(windows)]
#[derive(Debug)]
pub struct Error(pub String);

#[cfg(windows)]
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(windows)]
impl From<String> for Error {
    fn from(s: String) -> Self {
        Error(s)
    }
}

#[cfg(windows)]
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error(e.to_string())
    }
}

#[cfg(windows)]
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(windows)]
macro_rules! bail {
    ($($t:tt)*) => {
        return Err($crate::winuser::Error(format!($($t)*)))
    };
}
#[cfg(windows)]
pub(crate) use bail;

pub use crate::cli::WinUserCmd;

pub fn run(cmd: WinUserCmd) -> std::result::Result<serde_json::Value, String> {
    #[cfg(windows)]
    {
        let r = match cmd {
            WinUserCmd::Create { name, secret_out } => imp::create(&name, &secret_out),
            WinUserCmd::Delete {
                name,
                purge_profile,
            } => imp::delete(&name, purge_profile),
            WinUserCmd::List => imp::list(),
            WinUserCmd::Launch {
                name,
                secret_file,
                cwd,
                program,
                supervise,
            } => imp::launch(&name, &secret_file, cwd.as_deref(), &program, supervise),
            WinUserCmd::Grant { name, path } => imp::grant(&name, &path),
        };
        r.map_err(|e| e.0)
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
        Err("winuser commands are only available on Windows".into())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::imp;

    #[test]
    fn sid_and_profile_lookup() {
        assert_eq!(imp::account_sid("SYSTEM").as_deref(), Some("S-1-5-18"));
        let profile = imp::profile_path("S-1-5-18").unwrap();
        let p = profile.to_string_lossy().to_ascii_lowercase();
        assert!(p.ends_with("\\config\\systemprofile"), "{p:?}");
        assert!(imp::account_sid("dsh-no-such-account-xyz").is_none());
        assert!(imp::profile_path("S-1-5-21-1-2-3-4").is_none());
    }

    #[test]
    fn launch_reports_missing_secret() {
        let e = imp::launch(
            "x",
            "Z:\\dsh-no-such\\secret",
            None,
            &["cmd.exe".into()],
            false,
        )
        .unwrap_err();
        assert!(e.0.contains("reading"), "{}", e.0);
    }
}
