//! Installing the TermWrap payload and turning this machine into an RDP host.
//!
//! Follows TermWrap's own documented procedure (MIT, © llccd):
//!
//! 1. copy the DLLs to `%ProgramFiles%\RDP Wrapper\`;
//! 2. import the registry file the release ships (`Install_termwrap_umwrap.reg`, which points
//!    `TermService`/`UmRdpService` at the wrapper DLLs);
//! 3. enable the Remote Desktop host and make sure the accounts can log on;
//! 4. reboot — the wrapper is only loaded by the service at start-up.
//!
//! Nothing here is hidden or obfuscated: the payload travels inside our own release package and
//! is installed from there, so its integrity is the package's.

use std::path::{Path, PathBuf};

/// Default install directory, as documented by TermWrap.
pub fn default_target() -> PathBuf {
    let base = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
    PathBuf::from(base).join("RDP Wrapper")
}

/// Payload files that describe rather than install (never copied).
const META: [&str; 3] = ["VERSION", "LICENSE", "README.md"];

/// Copy the payload into `target` and return the copied file names.
pub fn stage_payload(payload: &Path, target: &Path) -> Result<Vec<String>, String> {
    if !payload.join("TermWrap.dll").is_file() {
        return Err(format!("{} has no TermWrap.dll", payload.display()));
    }
    std::fs::create_dir_all(target).map_err(|e| format!("creating {}: {e}", target.display()))?;
    let mut copied = Vec::new();
    for entry in
        std::fs::read_dir(payload).map_err(|e| format!("reading {}: {e}", payload.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if META.contains(&name.as_str()) || !entry.path().is_file() {
            continue;
        }
        let dst = target.join(&name);
        std::fs::copy(entry.path(), &dst).map_err(|e| format!("copying {name}: {e}"))?;
        copied.push(name);
    }
    copied.sort();
    Ok(copied)
}

/// Command line that manages a Defender exclusion for a directory.
///
/// Microsoft Defender has a first-party detection for this family (`HackTool:Win64/RDPWrap!MTB`),
/// so without an exclusion the wrapper is quarantined the moment it lands — the install would
/// look like it succeeded and the service would then fail to start. The step is explicit,
/// reported back to the user, and reversible (`Remove-MpPreference -ExclusionPath`).
pub fn defender_exclusion_command(path: &Path, add: bool) -> (String, Vec<String>) {
    let cmdlet = if add {
        "Add-MpPreference"
    } else {
        "Remove-MpPreference"
    };
    let quoted = path.display().to_string().replace('\'', "''");
    (
        "powershell.exe".into(),
        vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            format!("{cmdlet} -ExclusionPath '{quoted}'"),
        ],
    )
}

#[cfg(windows)]
mod install {
    use super::*;
    use serde_json::{Value, json};
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use windows_sys::Win32::NetworkManagement::NetManagement::*;
    use windows_sys::Win32::System::Registry::*;
    use windows_sys::Win32::System::Services::*;

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn set_dword(subkey: &str, value: &str, data: u32) -> Result<(), String> {
        let k = wide(subkey);
        let v = wide(value);
        let rc = unsafe {
            RegSetKeyValueW(
                HKEY_LOCAL_MACHINE,
                k.as_ptr(),
                v.as_ptr(),
                REG_DWORD,
                &data as *const u32 as *const _,
                4,
            )
        };
        if rc != 0 {
            return Err(format!("setting {subkey}\\{value} failed with code {rc}"));
        }
        Ok(())
    }

    /// Local group `Remote Desktop Users` (S-1-5-32-555); Windows Home does not create it.
    fn ensure_remote_desktop_users() -> Result<bool, String> {
        let name = wide("Remote Desktop Users");
        let comment = wide("Members can connect to this computer with Remote Desktop");
        let mut created = false;
        let mut info = LOCALGROUP_INFO_1 {
            lgrpi1_name: name.as_ptr() as *mut u16,
            lgrpi1_comment: comment.as_ptr() as *mut u16,
        };
        let mut parm = 0u32;
        let rc =
            unsafe { NetLocalGroupAdd(null_mut(), 1, &mut info as *mut _ as *mut u8, &mut parm) };
        if rc == 0 {
            created = true;
        } else if rc != NERR_GroupExists {
            return Err(format!(
                "NetLocalGroupAdd(Remote Desktop Users) failed with code {rc}"
            ));
        }
        Ok(created)
    }

    /// Add an account to the local `Remote Desktop Users` group, which is what grants the
    /// "log on through Remote Desktop Services" right the session logon needs.
    pub fn allow_account(account: &str) -> Result<Value, String> {
        let group = wide("Remote Desktop Users");
        let member = wide(account);
        let mut members = [LOCALGROUP_MEMBERS_INFO_3 {
            lgrmi3_domainandname: member.as_ptr() as *mut u16,
        }];
        let rc = unsafe {
            NetLocalGroupAddMembers(
                null_mut(),
                group.as_ptr(),
                3,
                members.as_mut_ptr() as *mut u8,
                1,
            )
        };
        // 1378 = ERROR_ALREADY_MEMBER: the account is set up already.
        if rc != 0 && rc != 1378 {
            return Err(format!(
                "adding {account} to \"Remote Desktop Users\" failed with code {rc} (is the group installed? run `session install` first)"
            ));
        }
        Ok(json!({ "ok": true, "account": account, "alreadyMember": rc == 1378 }))
    }

    /// `reg.exe import <file>` — exactly what TermWrap's README tells a human to do.
    fn import_reg(path: &Path) -> Result<(), String> {
        let out = std::process::Command::new("reg.exe")
            .arg("import")
            .arg(path)
            .output()
            .map_err(|e| format!("running reg.exe import: {e}"))?;
        if !out.status.success() {
            let text = String::from_utf8_lossy(&out.stderr);
            return Err(format!(
                "reg.exe import {} failed: {}",
                path.display(),
                text.trim()
            ));
        }
        Ok(())
    }

    fn start_service(name: &str) -> Result<String, String> {
        let w = wide(name);
        unsafe {
            let scm = OpenSCManagerW(null_mut(), null_mut(), SC_MANAGER_CONNECT);
            if scm.is_null() {
                return Err("OpenSCManager failed".into());
            }
            let svc = OpenServiceW(scm, w.as_ptr(), SERVICE_START | SERVICE_QUERY_STATUS);
            if svc.is_null() {
                CloseServiceHandle(scm);
                return Err(format!("opening service {name} failed"));
            }
            let started = StartServiceW(svc, 0, null_mut()) != 0;
            let mut buf = [0u8; std::mem::size_of::<SERVICE_STATUS_PROCESS>()];
            let mut needed = 0u32;
            let state = if windows_sys::Win32::System::Services::QueryServiceStatusEx(
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
                    SERVICE_START_PENDING => "starting",
                    SERVICE_STOPPED => "stopped",
                    _ => "other",
                }
            } else {
                "unknown"
            };
            CloseServiceHandle(svc);
            CloseServiceHandle(scm);
            Ok(if !started && state != "running" {
                format!("{state} (start request refused)")
            } else {
                state.to_string()
            })
        }
    }

    /// Ask Defender to leave the install directory alone. Returns a status string: a missing or
    /// disabled Defender must not abort the install, only be reported.
    fn add_defender_exclusion(target: &Path) -> String {
        let (cmd, args) = super::defender_exclusion_command(target, true);
        match std::process::Command::new(&cmd).args(&args).output() {
            Ok(out) if out.status.success() => format!("excluded {}", target.display()),
            Ok(out) => {
                let text = String::from_utf8_lossy(&out.stderr).trim().to_string();
                format!(
                    "not added ({}); if the wrapper gets quarantined, add {} to the Defender exclusions yourself",
                    if text.is_empty() {
                        "command failed".into()
                    } else {
                        text
                    },
                    target.display()
                )
            }
            Err(e) => format!(
                "not added ({e}); add {} to the Defender exclusions yourself",
                target.display()
            ),
        }
    }

    /// Everything `session install` does after the payload is verified.
    pub fn run(payload: &Path, target: &Path, exclusion: bool) -> Result<Value, String> {
        // Before anything lands on disk: keep Defender from quarantining the payload mid-install.
        let defender = if exclusion {
            add_defender_exclusion(target)
        } else {
            "skipped (--no-exclusion)".to_string()
        };
        let copied = stage_payload(payload, target)?;

        // UmWrap is what enables the extra redirection features on Home/Server SKUs; prefer the
        // registry file that matches what the payload actually contains.
        let wrapped = copied.iter().any(|f| f == "UmWrap.dll");
        let reg = if wrapped {
            payload.join("Install_termwrap_umwrap.reg")
        } else {
            payload.join("Install_termwrap_only.reg")
        };
        let registry = if reg.is_file() {
            import_reg(&reg)?;
            format!(
                "imported {}",
                reg.file_name().unwrap_or_default().to_string_lossy()
            )
        } else {
            // Fallback: point the two services at the wrapper DLLs ourselves.
            let dir = target.to_string_lossy().to_string();
            for (service, dll) in [
                ("TermService", "TermWrap.dll"),
                ("UmRdpService", "UmWrap.dll"),
            ] {
                if dll == "UmWrap.dll" && !wrapped {
                    continue;
                }
                let sub = format!("SYSTEM\\CurrentControlSet\\Services\\{service}\\Parameters");
                let value = format!("{dir}\\{dll}");
                let k = wide(&sub);
                let v = wide("ServiceDll");
                let data: Vec<u16> = OsStr::new(&value)
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect();
                let rc = unsafe {
                    RegSetKeyValueW(
                        HKEY_LOCAL_MACHINE,
                        k.as_ptr(),
                        v.as_ptr(),
                        REG_EXPAND_SZ,
                        data.as_ptr() as *const _,
                        (data.len() * 2) as u32,
                    )
                };
                if rc != 0 {
                    return Err(format!("pointing {service} at {dll} failed with code {rc}"));
                }
            }
            format!(
                "set ServiceDll for TermService{}",
                if wrapped { " and UmRdpService" } else { "" }
            )
        };

        set_dword(
            "SYSTEM\\CurrentControlSet\\Control\\Terminal Server",
            "fDenyTSConnections",
            0,
        )?;
        let group_created = ensure_remote_desktop_users()?;
        let term = start_service("TermService")?;
        let um = if wrapped {
            Some(start_service("UmRdpService")?)
        } else {
            None
        };

        Ok(json!({
            "ok": true,
            "target": target.to_string_lossy(),
            "defenderExclusion": defender,
            "files": copied,
            "registry": registry,
            "rdUsersGroupCreated": group_created,
            "services": { "TermService": term, "UmRdpService": um },
            "rebootRequired": true,
            "note": "the wrapper DLL is loaded by the service at start-up, so the machine has to be restarted before a second session can be created",
        }))
    }
}

#[cfg(windows)]
pub use install::{allow_account, run};

/// Arguments check shared by the CLI and tests.
pub fn require_payload(dir: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(dir);
    if !p.join("TermWrap.dll").is_file() {
        return Err(format!("{} has no TermWrap.dll", p.display()));
    }
    Ok(p)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn payload(files: &[(&str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-payload-{}", crate::util::random_u32()));
        std::fs::create_dir_all(&dir).unwrap();
        for (name, body) in files {
            std::fs::write(dir.join(name), body).unwrap();
        }
        dir
    }

    #[test]
    fn the_defender_command_is_quoted() {
        let (cmd, args) =
            defender_exclusion_command(Path::new("C:\\Program Files\\RDP Wrapper"), true);
        assert_eq!(cmd, "powershell.exe");
        assert_eq!(
            args[3],
            "Add-MpPreference -ExclusionPath 'C:\\Program Files\\RDP Wrapper'"
        );
        let (_, remove) = defender_exclusion_command(Path::new("C:\\x'y"), false);
        assert_eq!(remove[3], "Remove-MpPreference -ExclusionPath 'C:\\x''y'");
    }

    #[test]
    fn staging_copies_the_payload_and_skips_metadata() {
        let src = payload(&[
            ("TermWrap.dll", "dll"),
            ("UmWrap.dll", "um"),
            ("LICENSE", "mit"),
            ("VERSION", "0.6"),
        ]);
        let dst = src.join("out");
        let copied = stage_payload(&src, &dst).unwrap();
        assert_eq!(
            copied,
            vec!["TermWrap.dll".to_string(), "UmWrap.dll".to_string()]
        );
        assert_eq!(
            std::fs::read_to_string(dst.join("TermWrap.dll")).unwrap(),
            "dll"
        );
        assert!(!dst.join("LICENSE").exists());
        assert!(!dst.join("VERSION").exists());
        std::fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn a_payload_without_the_wrapper_is_refused() {
        let src = payload(&[("LICENSE", "mit")]);
        let dst = src.join("out");
        let err = stage_payload(&src, &dst).unwrap_err();
        assert!(err.contains("TermWrap.dll"), "{err}");
        assert!(!dst.exists(), "nothing may be copied from a bad payload");
        std::fs::remove_dir_all(&src).ok();
    }
}
