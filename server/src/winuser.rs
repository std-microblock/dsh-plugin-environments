//! Management of dsh-managed local Windows accounts.

#[cfg(windows)]
mod imp {
    use anyhow::{Context, Result, bail};
    use base64::Engine;
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
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
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
        const SETS: [&[u8]; 4] = [b"ABCDEFGHJKLMNPQRSTUVWXYZ", b"abcdefghijkmnopqrstuvwxyz", b"23456789", b"!#%+-=?@_"];
        let mut out = Vec::new();
        for set in SETS {
            for _ in 0..5 {
                out.push(set[rand::random::<u32>() as usize % set.len()]);
            }
        }
        // Fisher-Yates shuffle
        for i in (1..out.len()).rev() {
            let j = rand::random::<u32>() as usize % (i + 1);
            out.swap(i, j);
        }
        String::from_utf8(out).unwrap()
    }

    fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>> {
        unsafe {
            let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
            let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
            if CryptProtectData(&input, null(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) == 0 {
                bail!("CryptProtectData failed: {}", std::io::Error::last_os_error());
            }
            let v = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            LocalFree(output.pbData as _);
            Ok(v)
        }
    }

    fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>> {
        unsafe {
            let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
            let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
            if CryptUnprotectData(&input, null_mut(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) == 0 {
                bail!("CryptUnprotectData failed: {}", std::io::Error::last_os_error());
            }
            let v = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            LocalFree(output.pbData as _);
            Ok(v)
        }
    }

    fn profile_dir(name: &str) -> PathBuf {
        let base = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        PathBuf::from(format!("{base}\\Users\\{name}"))
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
        let encoded = base64::engine::general_purpose::STANDARD.encode(protected);
        std::fs::write(secret_out, encoded).with_context(|| format!("writing {secret_out}"))?;
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
                NetUserEnum(null(), 1, FILTER_NORMAL_ACCOUNT, &mut buf, MAX_PREFERRED_LENGTH, &mut read, &mut total, &mut resume)
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
                        let profile = profile_dir(&name);
                        out.push(json!({"name": name, "profile": profile.to_string_lossy(), "profileExists": profile.exists()}));
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
        if !managed.iter().any(|u| u["name"].as_str().map(|n| n.eq_ignore_ascii_case(name)).unwrap_or(false)) {
            bail!("`{name}` is not a dsh-managed account");
        }
        let wname = wide(name);
        let rc = unsafe { NetUserDel(null(), wname.as_ptr()) };
        if rc != 0 {
            bail!("NetUserDel failed with code {rc}");
        }
        if purge {
            let script = format!(
                "Get-CimInstance Win32_UserProfile | Where-Object {{ $_.LocalPath -like '*\\{name}' -and -not $_.Loaded }} | Remove-CimInstance"
            );
            let _ = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .status();
        }
        Ok(json!({"ok": true, "name": name}))
    }

    pub fn grant(name: &str, path: &str) -> Result<serde_json::Value> {
        let status = std::process::Command::new("icacls.exe")
            .args([path, "/grant", &format!("{name}:(OI)(CI)M"), "/T", "/Q"])
            .status()?;
        if !status.success() {
            bail!("icacls failed ({status})");
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

    pub fn launch(name: &str, secret_file: &str, cwd: Option<&str>, program: &[String]) -> Result<serde_json::Value> {
        if program.is_empty() {
            bail!("missing program");
        }
        let encoded = std::fs::read_to_string(secret_file).with_context(|| format!("reading {secret_file}"))?;
        let protected = base64::engine::general_purpose::STANDARD.decode(encoded.trim())?;
        let password = String::from_utf8(dpapi_unprotect(&protected)?)?;
        let cmdline = program.iter().map(|a| quote_arg(a)).collect::<Vec<_>>().join(" ");
        let mut wcmd = wide(&cmdline);
        let wuser = wide(name);
        let wdomain = wide(".");
        let wpass = wide(&password);
        let mut desktop = wide("winsta0\\default");
        let wcwd = cwd.map(wide);
        unsafe {
            let mut si: STARTUPINFOW = std::mem::zeroed();
            si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            si.lpDesktop = desktop.as_mut_ptr();
            si.dwFlags = STARTF_USESHOWWINDOW;
            si.wShowWindow = 0; // SW_HIDE for the server's own console
            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
            let ok = CreateProcessWithLogonW(
                wuser.as_ptr(),
                wdomain.as_ptr(),
                wpass.as_ptr(),
                LOGON_WITH_PROFILE,
                null(),
                wcmd.as_mut_ptr(),
                CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_CONSOLE,
                null(),
                wcwd.as_ref().map(|w| w.as_ptr()).unwrap_or(null()),
                &si,
                &mut pi,
            );
            if ok == 0 {
                bail!("CreateProcessWithLogonW failed: {}", std::io::Error::last_os_error());
            }
            let pid = pi.dwProcessId;
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            Ok(json!({"ok": true, "pid": pid}))
        }
    }
}

use clap::Subcommand;

#[derive(Subcommand, Debug)]
pub enum WinUserCmd {
    /// Create a dsh-managed standard local account (requires administrator rights).
    Create {
        #[arg(long)]
        name: String,
        #[arg(long)]
        secret_out: String,
    },
    /// Delete a dsh-managed account.
    Delete {
        #[arg(long)]
        name: String,
        #[arg(long)]
        purge_profile: bool,
    },
    /// List dsh-managed accounts.
    List,
    /// Start a program as a dsh-managed account on the interactive desktop.
    Launch {
        #[arg(long)]
        name: String,
        #[arg(long)]
        secret_file: String,
        #[arg(long)]
        cwd: Option<String>,
        #[arg(last = true, required = true)]
        program: Vec<String>,
    },
    /// Grant the account modify rights on a directory tree.
    Grant {
        #[arg(long)]
        name: String,
        #[arg(long)]
        path: String,
    },
}

pub fn run(cmd: WinUserCmd) -> anyhow::Result<serde_json::Value> {
    #[cfg(windows)]
    {
        match cmd {
            WinUserCmd::Create { name, secret_out } => imp::create(&name, &secret_out),
            WinUserCmd::Delete { name, purge_profile } => imp::delete(&name, purge_profile),
            WinUserCmd::List => imp::list(),
            WinUserCmd::Launch { name, secret_file, cwd, program } => imp::launch(&name, &secret_file, cwd.as_deref(), &program),
            WinUserCmd::Grant { name, path } => imp::grant(&name, &path),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
        anyhow::bail!("winuser commands are only available on Windows")
    }
}
