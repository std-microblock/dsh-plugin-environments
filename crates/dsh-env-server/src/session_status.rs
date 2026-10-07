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
        } => {
            #[cfg(windows)]
            {
                let payload = crate::termwrap::require_payload(&payload)?;
                let target = match target {
                    Some(t) => std::path::PathBuf::from(t),
                    None => crate::termwrap::default_target(),
                };
                crate::termwrap::run(&payload, &target, exclusion)
            }
            #[cfg(not(windows))]
            {
                let _ = (payload, target, exclusion);
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
    const TERMSRV_DLL: &str = "C:\\Windows\\System32\\termsrv.dll";
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

    /// Local group `S-1-5-32-555`; Windows Home does not create it.
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
            ) != 0
                && sid_len > 0
        }
    }

    #[allow(non_upper_case_globals)]
    fn sessions() -> Vec<Value> {
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
                let user = {
                    let mut buf = [0u16; 256];
                    let mut len = buf.len() as u32;
                    if WTSQuerySessionInformationW(
                        WTS_CURRENT_SERVER_HANDLE,
                        s.SessionId,
                        WTSUserName,
                        &mut buf.as_mut_ptr() as *mut *mut u16,
                        &mut len,
                    ) != 0
                    {
                        let p = buf.as_ptr();
                        let mut n = 0;
                        while *p.add(n) != 0 {
                            n += 1;
                        }
                        String::from_utf16_lossy(std::slice::from_raw_parts(p, n))
                    } else {
                        String::new()
                    }
                };
                out.push(json!({
                    "id": s.SessionId,
                    "name": name,
                    "user": user,
                    "state": match s.State {
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
                    },
                }));
            }
            WTSFreeMemory(table as *mut _);
        }
        out
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
        let version = file_version(&termsrv);

        let mut missing: Vec<&str> = Vec::new();
        let mut reasons: Vec<String> = Vec::new();
        if plain_termsrv {
            missing.push("termwrap-missing");
            reasons.push(
                "the multi-session patch (TermWrap) is not installed: a client SKU only allows one session, so a second logon would disconnect the console user".into(),
            );
        }
        if deny {
            missing.push("rdp-disabled");
            reasons.push("the Remote Desktop host is disabled (fDenyTSConnections=1)".into());
        }
        if !rfxvmt_present {
            missing.push("rfxvmt-missing");
            reasons.push(
                "rfxvmt.dll is missing: Windows Home does not ship it and the listener stays [not listening] until TermWrap restores it".into(),
            );
        }
        if !group {
            missing.push("rd-users-group-missing");
            reasons.push("the local group \"Remote Desktop Users\" does not exist".into());
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

        Ok(json!({
            "ok": true,
            "ready": ready,
            "missing": missing,
            "reasons": reasons,
            "edition": edition,
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
