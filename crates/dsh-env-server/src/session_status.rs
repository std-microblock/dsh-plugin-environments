//! Real-session mode: can this machine host a second interactive Windows session?
//!
//! A genuinely separate desktop (own cursor, own input desktop, `SendInput` works) requires a
//! Terminal Services session, which only the logon stack creates. On client SKUs that is gated
//! behind a SKU/licensing check inside `termsrv.dll` and a one-session limit; the RDP Wrapper
//! family (TermWrap) lifts both by patching the loaded image in memory. This command reports the
//! facts — registry, services, file versions, existing sessions — so the plugin can decide
//! whether the mode is offered and what to tell the user.

use crate::cli::SessionCmd;
use serde_json::Value;

pub fn run(cmd: SessionCmd) -> std::result::Result<Value, String> {
    match cmd {
        SessionCmd::Status => status(),
        SessionCmd::Install {
            payload,
            target,
            exclusion,
            restart,
        } => {
            #[cfg(windows)]
            {
                let payload = crate::termwrap::require_payload(&payload)?;
                let target = match target {
                    Some(t) => std::path::PathBuf::from(t),
                    None => crate::termwrap::default_target(),
                };
                crate::termwrap::run(&payload, &target, exclusion, restart)
            }
            #[cfg(not(windows))]
            {
                let _ = (payload, target, exclusion, restart);
                Err("TermWrap can only be installed on Windows hosts".into())
            }
        }
        SessionCmd::Allow { account } => {
            #[cfg(windows)]
            {
                crate::termwrap::allow_account(&account)
            }
            #[cfg(not(windows))]
            {
                let _ = account;
                Err("Remote Desktop logon is only available on Windows hosts".into())
            }
        }
        SessionCmd::Logoff { account } => {
            #[cfg(windows)]
            {
                imp::logoff(&account)
            }
            #[cfg(not(windows))]
            {
                let _ = account;
                Err("Remote Desktop logon is only available on Windows hosts".into())
            }
        }
        SessionCmd::Enable => {
            #[cfg(windows)]
            {
                crate::termwrap::enable_host()
            }
            #[cfg(not(windows))]
            {
                Err("Remote Desktop hosting is only available on Windows hosts".into())
            }
        }
    }
}

#[cfg(windows)]
fn status() -> std::result::Result<Value, String> {
    imp::status()
}

#[cfg(not(windows))]
fn status() -> std::result::Result<Value, String> {
    Ok(serde_json::json!({
        "ok": true,
        "ready": false,
        "platform": "unsupported",
        "missing": ["not-windows"],
        "reasons": ["real sessions are only meaningful on Windows hosts"],
    }))
}

#[cfg(windows)]
pub use imp::{end_current_session, sessions_of};

#[cfg(windows)]
mod imp {
    use serde_json::{Value, json};
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Security::*;
    use windows_sys::Win32::Storage::FileSystem::*;
    use windows_sys::Win32::System::Registry::*;
    use windows_sys::Win32::System::RemoteDesktop::*;
    use windows_sys::Win32::System::Services::*;

    const TS_KEY: &str = "SYSTEM\\CurrentControlSet\\Control\\Terminal Server";
    const RDP_PORT: u16 = 3389;

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn reg_string(subkey: &str, value: &str) -> Option<String> {
        let k = wide(subkey);
        let v = wide(value);
        let mut buf = vec![0u16; 1024];
        let mut len = (buf.len() * 2) as u32;
        let rc = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                k.as_ptr(),
                v.as_ptr(),
                RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
                null_mut(),
                buf.as_mut_ptr() as *mut _,
                &mut len,
            )
        };
        if rc != 0 {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }

    fn reg_dword(subkey: &str, value: &str) -> Option<u32> {
        let k = wide(subkey);
        let v = wide(value);
        let mut out = 0u32;
        let mut len = 4u32;
        let rc = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                k.as_ptr(),
                v.as_ptr(),
                RRF_RT_REG_DWORD,
                null_mut(),
                &mut out as *mut _ as *mut _,
                &mut len,
            )
        };
        (rc == 0).then_some(out)
    }

    /// Version the RDP Wrapper family keys its patches on.
    ///
    /// `termsrv.dll` carries a misleading string resource (e.g. `10.0.26100.8875`) next to a
    /// fixed file info of `6.2.26100.9444`; the community `rdpwrap.ini` sections use
    /// `10.0.<build>.<revision>` and match the *fixed* info, so that is what is reported here.
    fn file_version(path: &str) -> Option<String> {
        let w = wide(path);
        unsafe {
            let size = GetFileVersionInfoSizeW(w.as_ptr(), null_mut());
            if size == 0 {
                return None;
            }
            let mut buf = vec![0u8; size as usize];
            if GetFileVersionInfoW(w.as_ptr(), 0, size, buf.as_mut_ptr() as *mut _) == 0 {
                return None;
            }
            let mut info: *mut VS_FIXEDFILEINFO = null_mut();
            let mut len = 0u32;
            let sub = wide("\\");
            if VerQueryValueW(
                buf.as_ptr() as *const _,
                sub.as_ptr(),
                &mut info as *mut _ as *mut _,
                &mut len,
            ) == 0
                || info.is_null()
            {
                return None;
            }
            let f = &*info;
            let (major, minor) = (
                (f.dwFileVersionMS >> 16) & 0xFFFF,
                f.dwFileVersionMS & 0xFFFF,
            );
            // Windows 10/11 components keep a legacy 6.x major.minor in the fixed info.
            let (major, minor) = if major == 6 { (10, 0) } else { (major, minor) };
            Some(format!(
                "{major}.{minor}.{}.{}",
                f.dwFileVersionLS >> 16,
                f.dwFileVersionLS & 0xFFFF
            ))
        }
    }

    fn service_state(name: &str) -> Option<(String, String)> {
        let w = wide(name);
        unsafe {
            let scm = OpenSCManagerW(null(), null(), SC_MANAGER_CONNECT);
            if scm.is_null() {
                return None;
            }
            let svc = OpenServiceW(scm, w.as_ptr(), SERVICE_QUERY_STATUS | SERVICE_QUERY_CONFIG);
            if svc.is_null() {
                CloseServiceHandle(scm);
                return None;
            }
            let mut buf = [0u8; std::mem::size_of::<SERVICE_STATUS_PROCESS>()];
            let mut needed = 0u32;
            let state = if QueryServiceStatusEx(
                svc,
                SC_STATUS_PROCESS_INFO,
                buf.as_mut_ptr(),
                buf.len() as u32,
                &mut needed,
            ) != 0
            {
                let ssp = &*(buf.as_ptr() as *const SERVICE_STATUS_PROCESS);
                match ssp.dwCurrentState {
                    SERVICE_RUNNING => "running",
                    SERVICE_STOPPED => "stopped",
                    SERVICE_START_PENDING => "starting",
                    SERVICE_STOP_PENDING => "stopping",
                    SERVICE_PAUSED => "paused",
                    _ => "unknown",
                }
                .to_string()
            } else {
                "unknown".to_string()
            };
            let mut cfg_len = 0u32;
            let start = if QueryServiceConfigW(svc, null_mut(), 0, &mut cfg_len) == 0 && cfg_len > 0
            {
                let mut raw = vec![0u8; cfg_len as usize];
                if QueryServiceConfigW(
                    svc,
                    raw.as_mut_ptr() as *mut QUERY_SERVICE_CONFIGW,
                    cfg_len,
                    &mut cfg_len,
                ) != 0
                {
                    let cfg = raw.as_mut_ptr() as *mut QUERY_SERVICE_CONFIGW;
                    match (*cfg).dwStartType {
                        SERVICE_AUTO_START => "auto",
                        SERVICE_DEMAND_START => "manual",
                        SERVICE_DISABLED => "disabled",
                        SERVICE_BOOT_START => "boot",
                        SERVICE_SYSTEM_START => "system",
                        _ => "unknown",
                    }
                    .to_string()
                } else {
                    "unknown".to_string()
                }
            } else {
                "unknown".to_string()
            };
            CloseServiceHandle(svc);
            CloseServiceHandle(scm);
            Some((state, start))
        }
    }

    /// Whether 127.0.0.1:3389 accepts connections (the host is actually listening).
    fn listening() -> bool {
        use std::net::{Ipv4Addr, SocketAddr, TcpStream};
        use std::time::Duration;
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, RDP_PORT));
        TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
    }

    /// Whether a local group named "Remote Desktop Users" exists (the well-known S-1-5-32-555
    /// alias on Pro/Server; on Home only once the install has created a same-named group).
    ///
    /// The lookup is a size query: it always "fails" with ERROR_INSUFFICIENT_BUFFER, and the
    /// account exists exactly when the required SID length comes back non-zero.
    fn has_remote_desktop_users() -> bool {
        let w = wide("Remote Desktop Users");
        let mut sid_len = 0u32;
        let mut dom_len = 0u32;
        let mut kind: SID_NAME_USE = 0;
        unsafe {
            LookupAccountNameW(
                null(),
                w.as_ptr(),
                null_mut(),
                &mut sid_len,
                null_mut(),
                &mut dom_len,
                &mut kind,
            );
        }
        sid_len > 0
    }

    /// The account a session belongs to, or an empty string.
    ///
    /// `WTSQuerySessionInformationW` allocates the string and hands back the pointer: reading the
    /// buffer that was passed in instead yields an empty name for every session.
    fn session_user(id: u32) -> String {
        let mut buffer: *mut u16 = null_mut();
        let mut length = 0u32;
        unsafe {
            if WTSQuerySessionInformationW(
                WTS_CURRENT_SERVER_HANDLE,
                id,
                WTSUserName,
                &mut buffer,
                &mut length,
            ) == 0
                || buffer.is_null()
            {
                return String::new();
            }
            let mut end = 0usize;
            while *buffer.add(end) != 0 {
                end += 1;
            }
            let name = String::from_utf16_lossy(std::slice::from_raw_parts(buffer, end));
            WTSFreeMemory(buffer as *mut _);
            name
        }
    }

    /// Every session on this machine as `(id, station name, user name, raw state)`.
    fn session_list() -> Vec<(u32, String, String, i32)> {
        let mut table: *mut WTS_SESSION_INFOW = null_mut();
        let mut count = 0u32;
        let mut out = Vec::new();
        unsafe {
            if WTSEnumerateSessionsW(WTS_CURRENT_SERVER_HANDLE, 0, 1, &mut table, &mut count) == 0 {
                return out;
            }
            for s in std::slice::from_raw_parts(table, count as usize) {
                let name = if s.pWinStationName.is_null() {
                    String::new()
                } else {
                    let mut len = 0;
                    while *s.pWinStationName.add(len) != 0 {
                        len += 1;
                    }
                    String::from_utf16_lossy(std::slice::from_raw_parts(s.pWinStationName, len))
                };
                out.push((s.SessionId, name, session_user(s.SessionId), s.State));
            }
            WTSFreeMemory(table as *mut _);
        }
        out
    }

    /// Sessions that would swallow a logon for this account, ignoring the listener itself.
    ///
    /// A logged-on session of the account is what makes a later Remote Desktop logon useless: the
    /// connection reconnects to that session instead of creating one, so the account's logon shell
    /// never runs and the environment server inside it never starts.
    pub fn sessions_of(account: &str) -> Vec<u32> {
        session_list()
            .into_iter()
            .filter(|(_, station, user, _)| {
                !station.eq_ignore_ascii_case("RDP-Tcp") && user.eq_ignore_ascii_case(account)
            })
            .map(|(id, _, _, _)| id)
            .collect()
    }

    /// End every session of the account, so the next logon gets a fresh one.
    pub fn logoff(account: &str) -> Result<Value, String> {
        let ids = sessions_of(account);
        let mut ended = Vec::new();
        let mut denied = Vec::new();
        for id in ids {
            // Wait for the logoff to finish: a logon racing it would join a dying session.
            if unsafe { WTSLogoffSession(WTS_CURRENT_SERVER_HANDLE, id, 1) } != 0 {
                ended.push(id);
            } else {
                denied.push(id);
            }
        }
        if !denied.is_empty() {
            return Err(format!(
                "could not end session(s) {denied:?} of {account}: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(json!({"ok": true, "account": account, "ended": ended}))
    }

    /// End the session this process runs in (the logon shell calls this when the server exits, so a
    /// finished environment does not leave a session behind for the next logon to reconnect to).
    pub fn end_current_session() -> bool {
        use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
        let mut id = 0u32;
        if unsafe { ProcessIdToSessionId(std::process::id(), &mut id) } == 0 {
            return false;
        }
        unsafe { WTSLogoffSession(WTS_CURRENT_SERVER_HANDLE, id, 0) != 0 }
    }

    fn state_name(state: i32) -> &'static str {
        #[allow(non_upper_case_globals)]
        match state {
            WTSActive => "active",
            WTSConnected => "connected",
            WTSConnectQuery => "connect-query",
            WTSShadow => "shadow",
            WTSDisconnected => "disconnected",
            WTSIdle => "idle",
            WTSListen => "listen",
            WTSReset => "reset",
            WTSDown => "down",
            WTSInit => "init",
            _ => "unknown",
        }
    }

    fn sessions() -> Vec<Value> {
        session_list()
            .into_iter()
            .map(|(id, name, user, state)| {
                json!({"id": id, "name": name, "user": user, "state": state_name(state)})
            })
            .collect()
    }

    pub fn status() -> Result<Value, String> {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let termsrv = format!("{system_root}\\System32\\termsrv.dll");
        let rfxvmt = format!("{system_root}\\System32\\rfxvmt.dll");
        let service_dll = reg_string(
            "SYSTEM\\CurrentControlSet\\Services\\TermService\\Parameters",
            "ServiceDll",
        );
        let plain_termsrv = service_dll
            .as_deref()
            .is_none_or(|p| p.eq_ignore_ascii_case(&termsrv));
        let (service, start_type) =
            service_state("TermService").unwrap_or(("missing".into(), "missing".into()));
        let deny = reg_dword(TS_KEY, "fDenyTSConnections").unwrap_or(1) != 0;
        let listening = listening();
        let group = has_remote_desktop_users();
        let rfxvmt_present = Path::new(&rfxvmt).is_file();
        let edition = reg_string(
            "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
            "EditionID",
        );
        let install_type = reg_string(
            "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
            "InstallationType",
        );
        let version = file_version(&termsrv);

        // A Server SKU hosts several sessions natively; every *client* SKU (Home, Pro,
        // Enterprise, Education) allows only one at a time, so a second logon would disconnect
        // the console user and the multi-session patch is required. Home has it worse still: it
        // does not host Remote Desktop at all and ships without `rfxvmt.dll`.
        let server = install_type
            .as_deref()
            .is_some_and(|t| t.eq_ignore_ascii_case("server"));
        let home = edition
            .as_deref()
            .is_some_and(|e| e.to_ascii_lowercase().starts_with("core"));
        let kind = if server {
            "server"
        } else if home {
            "home"
        } else {
            "client"
        };
        let needs_termwrap = !server;

        let mut missing: Vec<&str> = Vec::new();
        let mut reasons: Vec<String> = Vec::new();
        if plain_termsrv && needs_termwrap {
            missing.push("termwrap-missing");
            reasons.push(if home {
                "this Home SKU does not host Remote Desktop at all and allows only one session; TermWrap (multi-session patch, MIT) lifts both limits".into()
            } else {
                "this client SKU allows only one session at a time, so a second logon would disconnect the console user; TermWrap (multi-session patch, MIT) lifts that limit".into()
            });
        }
        if deny {
            missing.push("rdp-disabled");
            reasons.push(if home {
                "the Remote Desktop host is disabled, and a Home SKU cannot enable it without the TermWrap patch (fDenyTSConnections=1)".into()
            } else {
                "the Remote Desktop host is disabled (fDenyTSConnections=1); it can simply be switched on here".into()
            });
        }
        // rfxvmt.dll is what a Home SKU lacks to bring the RDP listener up. Once the listener is
        // actually listening it has done its job (or was not needed), so it only blocks while the
        // listener is down; `system.rfxvmt` still reports the file itself.
        if !rfxvmt_present && !listening {
            missing.push("rfxvmt-missing");
            reasons.push(if home {
                "rfxvmt.dll is missing: a Home SKU does not ship it and the listener stays [not listening] until TermWrap restores it".into()
            } else {
                "rfxvmt.dll is missing, so the listener will not come up".into()
            });
        }
        if !group {
            missing.push("rd-users-group-missing");
            reasons.push(if home {
                "the local group \"Remote Desktop Users\" does not exist on a Home SKU; TermWrap's install recreates it".into()
            } else {
                "the local group \"Remote Desktop Users\" does not exist".into()
            });
        }
        if service != "running" {
            missing.push("term-service-stopped");
            reasons.push(format!(
                "the Terminal Services service is {service} (start: {start_type})"
            ));
        }
        if !listening {
            missing.push("listener-down");
            reasons.push(format!("nothing is listening on 127.0.0.1:{RDP_PORT}"));
        }
        let ready = missing.is_empty();

        // `needsTermWrap` says whether this machine needs the patch at all: a Server SKU hosts
        // several sessions natively, every client SKU does not.
        Ok(json!({
            "ok": true,
            "ready": ready,
            "missing": missing,
            "reasons": reasons,
            "edition": edition,
            "editionKind": kind,
            "server": server,
            "home": home,
            "needsTermWrap": needs_termwrap,
            "termsrv": {
                "path": termsrv,
                "exists": Path::new(&termsrv).is_file(),
                "version": version,
                "serviceDll": service_dll,
                "wrapperInstalled": !plain_termsrv,
            },
            "rdp": {
                "denyConnections": deny,
                "service": service,
                "serviceStart": start_type,
                "port": RDP_PORT,
                "listening": listening,
            },
            "system": {
                "rfxvmt": rfxvmt_present,
                "remoteDesktopUsersGroup": group,
            },
            "sessions": sessions(),
        }))
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn status_reports_this_machine() {
        let v = run(SessionCmd::Status).expect("status");
        assert_eq!(v["ok"], serde_json::json!(true));
        assert!(v["ready"].is_boolean());
        assert!(v["missing"].is_array());
        let path = v["termsrv"]["path"].as_str().unwrap_or_default();
        assert!(path.to_ascii_lowercase().ends_with("termsrv.dll"), "{path}");
        if v["termsrv"]["exists"] == serde_json::json!(true) {
            let version = v["termsrv"]["version"].as_str().unwrap_or_default();
            assert!(
                version.split('.').count() >= 3,
                "unexpected termsrv version {version:?}"
            );
        }
        // The probe runs in the interactive session, so at least one session must be listed.
        assert!(!v["sessions"].as_array().unwrap().is_empty());
        // `ready` must agree with `missing`.
        assert_eq!(
            v["ready"],
            serde_json::json!(v["missing"].as_array().unwrap().is_empty())
        );
    }
}
