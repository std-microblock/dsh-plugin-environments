//! Installing the TermWrap payload and turning this machine into an RDP host.
//!
//! Follows TermWrap's own documented procedure (MIT, © llccd):
//!
//! 1. copy the DLLs to `%ProgramFiles%\RDP Wrapper\`;
//! 2. import the registry file the release ships (`Install_termwrap_umwrap.reg`, which points
//!    `TermService`/`UmRdpService` at the wrapper DLLs);
//! 3. enable the Remote Desktop host and make sure the accounts can log on;
//! 4. restart `TermService`/`UmRdpService` — the wrapper is loaded by the service at start-up, so
//!    cycling the service loads it just as well as a reboot does (the SCM re-reads `ServiceDll` on
//!    every start). Only when the service cannot be cycled does the result still ask for a reboot.
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

/// What staging did: the files it wrote and the ones that already matched.
#[derive(Debug, Default, PartialEq)]
pub struct Staged {
    pub copied: Vec<String>,
    pub unchanged: Vec<String>,
}

/// Copy the payload into `target`.
///
/// A file whose content already matches is left untouched. That keeps a re-install from writing a
/// DLL a running service has loaded — Windows refuses to overwrite such a file — and it means the
/// install only has to stop the service when something really has to be replaced.
pub fn stage_payload(payload: &Path, target: &Path) -> Result<Staged, String> {
    if !payload.join("TermWrap.dll").is_file() {
        return Err(format!("{} has no TermWrap.dll", payload.display()));
    }
    std::fs::create_dir_all(target).map_err(|e| format!("creating {}: {e}", target.display()))?;
    let mut staged = Staged::default();
    for entry in
        std::fs::read_dir(payload).map_err(|e| format!("reading {}: {e}", payload.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if META.contains(&name.as_str()) || !entry.path().is_file() {
            continue;
        }
        let dst = target.join(&name);
        if same_content(&entry.path(), &dst) {
            staged.unchanged.push(name);
            continue;
        }
        std::fs::copy(entry.path(), &dst).map_err(|e| format!("copying {name}: {e}"))?;
        staged.copied.push(name);
    }
    staged.copied.sort();
    staged.unchanged.sort();
    Ok(staged)
}

/// Whether `dst` already holds exactly the bytes of `src`.
fn same_content(src: &Path, dst: &Path) -> bool {
    let (Ok(a), Ok(b)) = (std::fs::metadata(src), std::fs::metadata(dst)) else {
        return false;
    };
    if a.len() != b.len() {
        return false;
    }
    match (std::fs::read(src), std::fs::read(dst)) {
        (Ok(a), Ok(b)) => a == b,
        // An unreadable destination is not "identical": let the copy report the real error.
        _ => false,
    }
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
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
    use windows_sys::Win32::NetworkManagement::NetManagement::*;
    use windows_sys::Win32::System::Registry::*;
    use windows_sys::Win32::System::Services::*;

    /// Listener key whose DACL decides who may open a Remote Desktop connection at all.
    const RDP_TCP_KEY: &str =
        "SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp";
    /// Holds `DefaultSecurity`, the descriptor Windows copies to a listener that has none.
    const WINSTATIONS_KEY: &str =
        "SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations";
    /// `WINSTATION_QUERY | WINSTATION_CONNECT | WINSTATION_LOGON`: the access the default
    /// descriptor grants to the built-in "Remote Desktop Users" alias.
    const WINSTATION_USER_ACCESS: u32 = 0x121;
    /// `SECURITY_DESCRIPTOR_REVISION`, also not re-exported by windows-sys.
    const SECURITY_DESCRIPTOR_REVISION: u32 = 1;

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
        // A local group that already exists is reported as ERROR_ALIAS_EXISTS (1379), not as
        // NERR_GroupExists (which is for global groups); both mean there is nothing to do.
        const ERROR_ALIAS_EXISTS: u32 = 1379;
        if rc == 0 {
            created = true;
        } else if rc != NERR_GroupExists && rc != ERROR_ALIAS_EXISTS {
            return Err(format!(
                "NetLocalGroupAdd(Remote Desktop Users) failed with code {rc}"
            ));
        }
        Ok(created)
    }

    /// SID bytes of a local account or group.
    fn account_sid(name: &str) -> Result<Vec<u8>, String> {
        use windows_sys::Win32::Security::{LookupAccountNameW, SID_NAME_USE};
        let w = wide(name);
        let mut sid_len = 0u32;
        let mut dom_len = 0u32;
        let mut kind: SID_NAME_USE = 0;
        // Size query: fails with ERROR_INSUFFICIENT_BUFFER and fills in both lengths.
        unsafe {
            LookupAccountNameW(
                null_mut(),
                w.as_ptr(),
                null_mut(),
                &mut sid_len,
                null_mut(),
                &mut dom_len,
                &mut kind,
            );
        }
        if sid_len == 0 {
            return Err(format!("the local account {name} does not exist"));
        }
        let mut sid = vec![0u8; sid_len as usize];
        let mut dom = vec![0u16; dom_len.max(1) as usize];
        let ok = unsafe {
            LookupAccountNameW(
                null_mut(),
                w.as_ptr(),
                sid.as_mut_ptr() as *mut _,
                &mut sid_len,
                dom.as_mut_ptr(),
                &mut dom_len,
                &mut kind,
            )
        };
        if ok == 0 {
            return Err(format!("looking up account {name} failed"));
        }
        Ok(sid)
    }

    /// The listener's security descriptor as the registry stores it (a self-relative
    /// `SECURITY_DESCRIPTOR`). Windows keeps it on the `RDP-Tcp` key and falls back to the
    /// `WinStations` default when that key has none.
    fn listener_descriptor() -> Result<Vec<u8>, String> {
        for (key, value) in [
            (RDP_TCP_KEY, "Security"),
            (WINSTATIONS_KEY, "DefaultSecurity"),
        ] {
            if let Some(bytes) = reg_binary(key, value) {
                return Ok(bytes);
            }
        }
        Err("the Remote Desktop listener has no security descriptor to extend".into())
    }

    fn reg_binary(subkey: &str, value: &str) -> Option<Vec<u8>> {
        let k = wide(subkey);
        let v = wide(value);
        let mut buf = vec![0u8; 64 * 1024];
        let mut len = buf.len() as u32;
        let rc = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                k.as_ptr(),
                v.as_ptr(),
                RRF_RT_REG_BINARY,
                null_mut(),
                buf.as_mut_ptr() as *mut _,
                &mut len,
            )
        };
        if rc != 0 {
            return None;
        }
        buf.truncate(len as usize);
        Some(buf)
    }

    fn set_binary(subkey: &str, value: &str, data: &[u8]) -> Result<(), String> {
        let k = wide(subkey);
        let v = wide(value);
        let rc = unsafe {
            RegSetKeyValueW(
                HKEY_LOCAL_MACHINE,
                k.as_ptr(),
                v.as_ptr(),
                REG_BINARY,
                data.as_ptr() as *const _,
                data.len() as u32,
            )
        };
        if rc != 0 {
            return Err(format!("writing {subkey}\\{value} failed with code {rc}"));
        }
        Ok(())
    }

    /// Let an account through the listener's own security descriptor.
    ///
    /// Connecting is gated on the `RDP-Tcp` listener's DACL, which grants `WINSTATION_QUERY |
    /// CONNECT | LOGON` to Administrators and to the *built-in* Remote Desktop Users alias
    /// (S-1-5-32-555). Windows Home has no such alias — the group the install creates there is an
    /// ordinary machine group, so membership does not satisfy that ACE — and until this runs the
    /// server answers the logon with "access denied" during CredSSP, before any credentials are
    /// even checked.
    ///
    /// The descriptor is rebuilt from an absolute copy of the stored one, so owner, group, audit
    /// SACL and control flags survive: a descriptor carrying only a DACL is accepted by the
    /// registry but makes `TermService` refuse every connection.
    fn allow_listener(account: &str) -> Result<(), String> {
        use windows_sys::Win32::Security::Authorization::{
            EXPLICIT_ACCESS_W, GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, SetEntriesInAclW, TRUSTEE_IS_SID,
            TRUSTEE_IS_USER, TRUSTEE_W,
        };
        use windows_sys::Win32::Security::{
            ACL, GetSecurityDescriptorDacl, MakeAbsoluteSD, MakeSelfRelativeSD,
            PSECURITY_DESCRIPTOR, PSID, SetSecurityDescriptorDacl,
        };
        let mut sid = account_sid(account)?;
        let mut stored = listener_descriptor()?;
        unsafe {
            // MakeAbsoluteSD sizes itself: the first call fills in the required lengths.
            let (mut abs_len, mut dacl_len, mut sacl_len, mut owner_len, mut group_len) =
                (0u32, 0u32, 0u32, 0u32, 0u32);
            MakeAbsoluteSD(
                stored.as_mut_ptr() as PSECURITY_DESCRIPTOR,
                null_mut(),
                &mut abs_len,
                null_mut(),
                &mut dacl_len,
                null_mut(),
                &mut sacl_len,
                null_mut(),
                &mut owner_len,
                null_mut(),
                &mut group_len,
            );
            let mut absolute = vec![0u8; abs_len as usize];
            let mut dacl_buf = vec![0u8; dacl_len as usize];
            let mut sacl_buf = vec![0u8; sacl_len as usize];
            let mut owner_buf = vec![0u8; owner_len as usize];
            let mut group_buf = vec![0u8; group_len as usize];
            if MakeAbsoluteSD(
                stored.as_mut_ptr() as PSECURITY_DESCRIPTOR,
                absolute.as_mut_ptr() as PSECURITY_DESCRIPTOR,
                &mut abs_len,
                dacl_buf.as_mut_ptr() as *mut ACL,
                &mut dacl_len,
                sacl_buf.as_mut_ptr() as *mut ACL,
                &mut sacl_len,
                owner_buf.as_mut_ptr() as PSID,
                &mut owner_len,
                group_buf.as_mut_ptr() as PSID,
                &mut group_len,
            ) == 0
            {
                return Err("MakeAbsoluteSD failed".into());
            }
            let absolute = absolute.as_mut_ptr() as PSECURITY_DESCRIPTOR;
            let mut dacl: *mut ACL = null_mut();
            let mut present = 0;
            let mut defaulted = 0;
            if GetSecurityDescriptorDacl(absolute, &mut present, &mut dacl, &mut defaulted) == 0 {
                return Err("GetSecurityDescriptorDacl failed".into());
            }
            let entry = EXPLICIT_ACCESS_W {
                grfAccessPermissions: WINSTATION_USER_ACCESS,
                grfAccessMode: GRANT_ACCESS,
                grfInheritance: 0,
                Trustee: TRUSTEE_W {
                    pMultipleTrustee: null_mut(),
                    MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_USER,
                    ptstrName: sid.as_mut_ptr() as *mut u16,
                },
            };
            let mut updated: *mut ACL = null_mut();
            let rc = SetEntriesInAclW(1, &entry, dacl, &mut updated);
            if rc != 0 {
                return Err(format!("SetEntriesInAclW failed with code {rc}"));
            }
            let relative = if SetSecurityDescriptorDacl(absolute, 1, updated, defaulted) == 0 {
                Vec::new()
            } else {
                let mut size = 0u32;
                MakeSelfRelativeSD(absolute, null_mut(), &mut size);
                let mut out = vec![0u8; size as usize];
                if MakeSelfRelativeSD(
                    absolute,
                    out.as_mut_ptr() as PSECURITY_DESCRIPTOR,
                    &mut size,
                ) == 0
                {
                    Vec::new()
                } else {
                    out.truncate(size as usize);
                    out
                }
            };
            LocalFree(updated as _);
            if relative.is_empty() {
                return Err("building the new listener descriptor failed".into());
            }
            set_binary(RDP_TCP_KEY, "Security", &relative)
        }
    }

    /// Let an account log on through Remote Desktop: membership of `Remote Desktop Users` (for
    /// Pro and Server, where that group carries the right), the right itself on the account (which
    /// is what makes it work on Home) and access to the listener (again because Home has no
    /// built-in Remote Desktop Users alias). Idempotent.
    pub fn allow_account(account: &str) -> Result<Value, String> {
        let group_created = ensure_remote_desktop_users()?;
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
                "adding {account} to \"Remote Desktop Users\" failed with code {rc}"
            ));
        }
        let mut sid = account_sid(account)?;
        grant_remote_logon(&mut sid)?;
        allow_listener(account)?;
        Ok(json!({
            "ok": true,
            "account": account,
            "alreadyMember": rc == 1378,
            "groupCreated": group_created,
            "remoteLogonRight": true,
            "listenerAccess": true,
        }))
    }

    /// Grant `SeRemoteInteractiveLogonRight` to a SID.    ///
    /// The default policy grants it to Administrators and to the *well-known* Remote Desktop
    /// Users alias (S-1-5-32-555). Windows Home has no such alias, and the same-named group the
    /// install creates there gets an ordinary machine SID that the policy does not mention — so
    /// membership alone grants nothing on Home. Granting the right to the account itself works on
    /// every SKU.
    fn grant_remote_logon(sid: &mut [u8]) -> Result<(), String> {
        use windows_sys::Win32::Security::Authentication::Identity::*;
        let right = wide("SeRemoteInteractiveLogonRight");
        let chars = (right.len() - 1) as u16;
        let rights = LSA_UNICODE_STRING {
            Length: chars * 2,
            MaximumLength: chars * 2,
            Buffer: right.as_ptr() as *mut u16,
        };
        let attrs: LSA_OBJECT_ATTRIBUTES = unsafe { std::mem::zeroed() };
        let mut policy: LSA_HANDLE = 0 as LSA_HANDLE;
        unsafe {
            let st = LsaOpenPolicy(
                null_mut(),
                &attrs,
                (POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES) as u32,
                &mut policy,
            );
            if st != 0 {
                return Err(format!(
                    "LsaOpenPolicy failed with code {} (needs administrator rights)",
                    LsaNtStatusToWinError(st)
                ));
            }
            let st = LsaAddAccountRights(policy, sid.as_mut_ptr() as *mut _, &rights, 1);
            LsaClose(policy);
            if st != 0 {
                return Err(format!(
                    "granting SeRemoteInteractiveLogonRight failed with code {}",
                    LsaNtStatusToWinError(st)
                ));
            }
        }
        Ok(())
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

    /// How long to wait for a service to reach the state we asked for.
    const SERVICE_TIMEOUT: Duration = Duration::from_secs(20);
    /// How often the copy may be retried with the stack stopped before the install gives up.
    const COPY_ATTEMPTS: usize = 3;

    /// `dwCurrentState` as the string the JSON reports (also used by the unit tests).
    pub(super) fn state_name(state: u32) -> &'static str {
        match state {
            SERVICE_RUNNING => "running",
            SERVICE_START_PENDING => "starting",
            SERVICE_STOP_PENDING => "stopping",
            SERVICE_STOPPED => "stopped",
            SERVICE_PAUSED => "paused",
            _ => "unknown",
        }
    }

    /// A service handle; both the SCM and the service handle close on drop.
    struct Service {
        scm: SC_HANDLE,
        svc: SC_HANDLE,
        name: String,
    }

    impl Service {
        fn open(name: &str, access: u32) -> Result<Self, String> {
            let w = wide(name);
            unsafe {
                let scm = OpenSCManagerW(null_mut(), null_mut(), SC_MANAGER_CONNECT);
                if scm.is_null() {
                    return Err("OpenSCManager failed (needs administrator rights)".into());
                }
                let svc = OpenServiceW(scm, w.as_ptr(), access);
                if svc.is_null() {
                    let code = GetLastError();
                    CloseServiceHandle(scm);
                    return Err(format!("opening service {name} failed with code {code}"));
                }
                Ok(Self {
                    scm,
                    svc,
                    name: name.to_string(),
                })
            }
        }

        /// `dwCurrentState`, or `u32::MAX` when it cannot be queried.
        fn state(&self) -> u32 {
            let mut buf = [0u8; std::mem::size_of::<SERVICE_STATUS_PROCESS>()];
            let mut needed = 0u32;
            unsafe {
                if QueryServiceStatusEx(
                    self.svc,
                    SC_STATUS_PROCESS_INFO,
                    buf.as_mut_ptr(),
                    buf.len() as u32,
                    &mut needed,
                ) != 0
                {
                    (*(buf.as_ptr() as *const SERVICE_STATUS_PROCESS)).dwCurrentState
                } else {
                    u32::MAX
                }
            }
        }

        /// Wait out `START_PENDING`/`STOP_PENDING` and report the state it settled on.
        fn settle(&self) -> u32 {
            let deadline = Instant::now() + SERVICE_TIMEOUT;
            loop {
                let state = self.state();
                if state != SERVICE_START_PENDING && state != SERVICE_STOP_PENDING {
                    return state;
                }
                if Instant::now() >= deadline {
                    return state;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }

        /// Start the service (a no-op while it already runs) and wait for it.
        fn start(&self) -> Result<String, String> {
            let state = self.state();
            if state != SERVICE_RUNNING && state != SERVICE_START_PENDING {
                unsafe { StartServiceW(self.svc, 0, null_mut()) };
            }
            Ok(state_name(self.settle()).to_string())
        }

        /// Stop the service and wait until it is really down.
        fn stop(&self) -> Result<String, String> {
            let state = self.state();
            if state != SERVICE_STOPPED && state != SERVICE_STOP_PENDING {
                let mut status: SERVICE_STATUS = unsafe { std::mem::zeroed() };
                if unsafe { ControlService(self.svc, SERVICE_CONTROL_STOP, &mut status) } == 0 {
                    let code = unsafe { GetLastError() };
                    return Err(format!("stopping {} failed with code {code}", self.name));
                }
            }
            Ok(state_name(self.settle()).to_string())
        }
    }

    impl Drop for Service {
        fn drop(&mut self) {
            unsafe {
                CloseServiceHandle(self.svc);
                CloseServiceHandle(self.scm);
            }
        }
    }

    /// Reported state of a service, or `None` when this machine does not have it.
    pub(super) fn service_state(name: &str) -> Option<String> {
        let svc = Service::open(name, SERVICE_QUERY_STATUS).ok()?;
        Some(state_name(svc.state()).to_string())
    }

    /// Start `name` (a no-op when it already runs) and report the state it settled on.
    fn start_service(name: &str) -> Result<String, String> {
        Service::open(name, SERVICE_START | SERVICE_QUERY_STATUS)?.start()
    }

    /// Stop `name`, if this machine has it and it is running.
    fn stop_service(name: &str) -> Result<String, String> {
        Service::open(name, SERVICE_STOP | SERVICE_QUERY_STATUS)?.stop()
    }

    /// Stop `name` when it is present; returns whether it is down and a note for the report.
    pub(super) fn stop_if_present(name: &str) -> (bool, String) {
        match service_state(name) {
            None => (false, format!("{name}: absent")),
            Some(_) => match stop_service(name) {
                Ok(state) => (state == "stopped", format!("{name}: {state}")),
                Err(e) => (false, format!("{name}: {e}")),
            },
        }
    }

    /// One service's report: `{present, before, stopped, after}`, `{present: false}`, or `{error}`.
    pub(super) fn describe(
        before: Option<String>,
        stopped: Result<String, String>,
        started: Result<String, String>,
    ) -> Value {
        let Some(before) = before else {
            return json!({ "present": false });
        };
        let mut report = json!({ "present": true, "before": before });
        for (key, outcome) in [("stopped", stopped), ("after", started)] {
            match outcome {
                Ok(state) => report[key] = json!(state),
                Err(e) => {
                    report["error"] = json!(e);
                    break;
                }
            }
        }
        report
    }

    /// Cycle the Terminal Services stack: dependents down first, then dependencies back up.
    ///
    /// The phases may not be interleaved per service: starting `UmRdpService` pulls `TermService`
    /// back up as its dependency, and Windows then refuses to stop `TermService` with
    /// `ERROR_DEPENDENT_SERVICES_RUNNING` (1051) — leaving the old DLL in the running process.
    ///
    /// Returns the report and whether `TermService` really went down and came back up, which is the
    /// only thing that proves the running service loaded the files now on disk.
    fn cycle_term_services(um: bool) -> (Value, bool) {
        let um_before = um.then(|| service_state("UmRdpService")).flatten();
        let term_before = service_state("TermService");
        let um_stopped = um.then(|| stop_service("UmRdpService"));
        let term_stopped = stop_service("TermService");
        let down = matches!(term_stopped, Ok(ref state) if state == "stopped");
        let term_started = start_service("TermService");
        let um_started = um.then(|| start_service("UmRdpService"));
        let running = matches!(term_started, Ok(ref state) if state == "running");

        let mut report =
            json!({ "termService": describe(term_before, term_stopped, term_started) });
        if um {
            // Both phases ran whenever `um` is true, so neither fallback can actually be reported.
            let stopped = um_stopped.unwrap_or(Err("not cycled".into()));
            let started = um_started.unwrap_or(Err("not cycled".into()));
            report["umRdpService"] = describe(um_before, stopped, started);
        }
        (report, down && running)
    }

    /// Whether 127.0.0.1:3389 accepts connections again (the host is listening).
    fn listener_up() -> bool {
        use std::net::{Ipv4Addr, SocketAddr, TcpStream};
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, 3389));
        TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
    }

    /// Whether a reboot is still the only way to get the wrapper loaded.
    ///
    /// A service that never went down keeps the DLL it started with, and a host that is not
    /// listening yet proves nothing either: only "reloaded *and* listening again" is a real
    /// success, everything else keeps the conservative advice.
    pub(super) fn reboot_required(reloaded: bool, listener: bool) -> bool {
        !(reloaded && listener)
    }

    /// Wait for the listener to come back after a cycle; a slow machine gets 15 seconds.
    fn wait_for_listener() -> bool {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if listener_up() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(300));
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

    /// Turn this machine into a Remote Desktop host **without** the patch.
    ///
    /// This is the right path for a Server SKU, which hosts several sessions natively: all it
    /// needs is the listener switched on and the accounts allowed to log on. On a client SKU the
    /// same steps are necessary but not sufficient (one session at a time), which is what the
    /// TermWrap install adds.
    pub fn enable_host() -> Result<Value, String> {
        set_dword(
            "SYSTEM\\CurrentControlSet\\Control\\Terminal Server",
            "fDenyTSConnections",
            0,
        )?;
        let group_created = ensure_remote_desktop_users()?;
        let term = start_service("TermService")?;
        // UmRdpService exists on client SKUs too; only report it when this machine has it.
        let um = start_service("UmRdpService").ok();
        Ok(json!({
            "ok": true,
            "rdUsersGroupCreated": group_created,
            "services": { "TermService": term, "UmRdpService": um },
            "rebootRequired": false,
            "note": "the Remote Desktop host is enabled; on a non-Server SKU the multi-session patch (TermWrap) is still what lets a second session exist next to yours",
        }))
    }

    /// Everything `session install` does after the payload is verified.
    ///
    /// `restart` cycles `TermService`/`UmRdpService` at the end, which is what the upstream
    /// instructions use a reboot for; with `restart` off the caller gets the old behaviour (the
    /// services are only started), so a reboot is what makes the wrapper take effect.
    pub fn run(
        payload: &Path,
        target: &Path,
        exclusion: bool,
        restart: bool,
    ) -> Result<Value, String> {
        // Before anything lands on disk: keep Defender from quarantining the payload mid-install.
        let defender = if exclusion {
            add_defender_exclusion(target)
        } else {
            "skipped (--no-exclusion)".to_string()
        };

        // Windows refuses to overwrite a DLL a running service has loaded, so replacing a wrapper
        // that is already in use needs the stack down for the copy. Identical files are skipped by
        // `stage_payload`, so the usual re-install never gets here at all. When it does, the copy is
        // retried with the stack stopped: `TermService` is trigger-started (an RPC/WTS call such as
        // the environments page probing its own status is enough), so one stop is not guaranteed to
        // hold long enough.
        let mut pre_stop: Vec<String> = Vec::new();
        let mut stack_down = false;
        let mut staged = None;
        let mut last_error = String::new();
        let attempts = if restart { COPY_ATTEMPTS } else { 1 };
        for attempt in 0..attempts {
            match stage_payload(payload, target) {
                Ok(done) => {
                    staged = Some(done);
                    break;
                }
                Err(e) => {
                    last_error = e;
                    if attempt + 1 < attempts {
                        let (stopped, notes) = stop_stack();
                        stack_down |= stopped;
                        pre_stop.extend(notes);
                    }
                }
            }
        }
        let Some(staged) = staged else {
            return Err(if stack_down {
                put_stack_back(last_error, &pre_stop)
            } else {
                last_error
            });
        };

        match apply(payload, target, staged, &defender, &pre_stop, restart) {
            Ok(result) => Ok(result),
            // A failure after the payload landed must not leave Terminal Services down: that would
            // cost the user the Remote Desktop host itself, not just the patch.
            Err(e) if stack_down => Err(put_stack_back(e, &pre_stop)),
            Err(e) if pre_stop.is_empty() => Err(e),
            Err(e) => Err(format!("{e} ({})", pre_stop.join("; "))),
        }
    }

    /// Stop the Terminal Services stack, dependents first.
    ///
    /// Returns whether anything actually went down — a refused stop needs no attempt to put it
    /// back — together with a note per service for the report.
    fn stop_stack() -> (bool, Vec<String>) {
        let mut down = false;
        let mut notes = Vec::new();
        for name in ["UmRdpService", "TermService"] {
            let (stopped, note) = stop_if_present(name);
            down |= stopped;
            notes.push(note);
        }
        (down, notes)
    }

    /// Best effort to start the stack again after a failure, with what happened appended.
    fn put_stack_back(error: String, pre_stop: &[String]) -> String {
        let term = start_service("TermService").unwrap_or_else(|e| e);
        let um = start_service("UmRdpService").unwrap_or_else(|e| e);
        format!(
            "{error} (Terminal Services: {}; start attempt afterwards: TermService {term}, UmRdpService {um})",
            pre_stop.join("; ")
        )
    }

    /// Everything after the payload is on disk: registry, host settings, and the service cycle that
    /// loads the wrapper.
    fn apply(
        payload: &Path,
        target: &Path,
        staged: Staged,
        defender: &str,
        pre_stop: &[String],
        restart: bool,
    ) -> Result<Value, String> {
        // UmWrap is what enables the extra redirection features on Home/Server SKUs; prefer the
        // registry file that matches what the payload actually contains.
        let wrapped = payload.join("UmWrap.dll").is_file();
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

        // The wrapper is loaded when the service starts, so the install has to (re)start Terminal
        // Services after the files landed — restarting is also the only way to reload a service
        // that is already running an older DLL.
        let um = service_state("UmRdpService").is_some();
        let (restart_report, reloaded) = if restart {
            cycle_term_services(um)
        } else {
            let was_running = service_state("TermService").as_deref() == Some("running");
            let term = start_service("TermService")?;
            let um_state = um.then(|| start_service("UmRdpService").ok()).flatten();
            let reloaded = !was_running && term == "running";
            (
                json!({ "skipped": true, "termService": term, "umRdpService": um_state }),
                reloaded,
            )
        };
        let term_state = service_state("TermService").unwrap_or_else(|| "unknown".into());
        let um_state = service_state("UmRdpService");
        let listener = term_state == "running" && wait_for_listener();
        let needs_reboot = reboot_required(reloaded, listener);

        Ok(json!({
            "ok": true,
            "target": target.to_string_lossy(),
            "defenderExclusion": defender,
            "files": staged.copied,
            "unchanged": staged.unchanged,
            "registry": registry,
            "rdUsersGroupCreated": group_created,
            "stoppedForCopy": pre_stop,
            "restart": restart_report,
            "services": { "TermService": term_state, "UmRdpService": um_state },
            "reloaded": reloaded,
            "listener": listener,
            "rebootRequired": needs_reboot,
            "note": if needs_reboot {
                "the wrapper is loaded by the service when it starts, and this run did not manage to restart Terminal Services with it, so the machine has to be rebooted before a second session can be created"
            } else {
                "the Terminal Services service was restarted with the wrapper DLL in place and is listening again, so the patch is active without a reboot"
            },
        }))
    }
}

#[cfg(windows)]
pub use install::{allow_account, enable_host, run};

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
        let staged = stage_payload(&src, &dst).unwrap();
        assert_eq!(
            staged.copied,
            vec!["TermWrap.dll".to_string(), "UmWrap.dll".to_string()]
        );
        assert!(staged.unchanged.is_empty());
        assert_eq!(
            std::fs::read_to_string(dst.join("TermWrap.dll")).unwrap(),
            "dll"
        );
        assert!(!dst.join("LICENSE").exists());
        assert!(!dst.join("VERSION").exists());
        std::fs::remove_dir_all(&src).ok();
    }

    /// A file that is already there with the same bytes must not be written again: that is what
    /// keeps a re-install from touching a DLL the running service has locked.
    #[test]
    fn staging_leaves_an_identical_file_alone() {
        let src = payload(&[("TermWrap.dll", "dll")]);
        let dst = src.join("out");
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(dst.join("TermWrap.dll"), "dll").unwrap();
        let staged = stage_payload(&src, &dst).unwrap();
        assert!(staged.copied.is_empty(), "{staged:?}");
        assert_eq!(staged.unchanged, vec!["TermWrap.dll".to_string()]);
        // A different file is replaced, and a longer one is not mistaken for a match.
        std::fs::write(dst.join("TermWrap.dll"), "dll-changed").unwrap();
        assert_eq!(
            stage_payload(&src, &dst).unwrap().copied,
            vec!["TermWrap.dll".to_string()]
        );
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

    /// The old behaviour asked for a reboot unconditionally; now only a service that did not come
    /// back listening does.
    #[test]
    fn a_reboot_is_only_asked_for_when_the_service_was_not_reloaded() {
        assert!(!install::reboot_required(true, true));
        assert!(install::reboot_required(true, false));
        assert!(install::reboot_required(false, true));
        assert!(install::reboot_required(false, false));
    }

    /// A machine without `UmRdpService` must not fail the install, which is what makes the
    /// unconditional cycle safe.
    #[test]
    fn a_missing_service_is_reported_not_fatal() {
        let (down, note) = install::stop_if_present("dsh-no-such-service");
        assert!(!down, "nothing can go down that does not exist");
        assert!(note.contains("absent"), "{note}");
        assert_eq!(install::service_state("dsh-no-such-service"), None);
    }

    #[test]
    fn service_states_have_stable_names() {
        use windows_sys::Win32::System::Services::{SERVICE_RUNNING, SERVICE_STOPPED};
        assert_eq!(install::state_name(SERVICE_RUNNING), "running");
        assert_eq!(install::state_name(SERVICE_STOPPED), "stopped");
        assert_eq!(install::state_name(u32::MAX), "unknown");
    }

    #[test]
    fn a_cycle_report_says_what_happened_to_each_service() {
        let report = install::describe(
            Some("running".into()),
            Ok("stopped".into()),
            Ok("running".into()),
        );
        assert_eq!(
            report,
            serde_json::json!({"present": true, "before": "running", "stopped": "stopped", "after": "running"})
        );
        assert_eq!(
            install::describe(None, Err("x".into()), Err("x".into())),
            serde_json::json!({"present": false})
        );
        // A refused stop keeps the state it failed in and never claims the service came back.
        assert_eq!(
            install::describe(
                Some("running".into()),
                Err("stopping TermService failed with code 1051".into()),
                Ok("running".into()),
            ),
            serde_json::json!({
                "present": true,
                "before": "running",
                "error": "stopping TermService failed with code 1051"
            })
        );
    }
}
