//! Window-station desktops.
//!
//! A private desktop (`WinSta0\dsh-<account>`) gives one isolated account its own set of
//! top-level windows inside the interactive session: the human's desktop never shows them and
//! `EnumWindows`/`EnumDesktopWindows` lists stay separate. Two consequences drive the code
//! elsewhere in the server:
//!
//! - the desktop object is reference counted: it dies when its last handle closes, so whoever
//!   creates it must stay alive for as long as the environment uses it;
//! - a desktop that is not the session's *input* desktop cannot be captured with
//!   `GetDC(NULL)`/`BitBlt` and cannot receive `SendInput` (see `screen.rs` / `input.rs`).

/// Desktop names may not contain a backslash and are case-insensitive.
pub fn private_name(account: &str) -> String {
    let mut out = String::from("dsh-");
    for c in account.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c.to_ascii_lowercase());
        } else {
            out.push('_');
        }
    }
    out
}

#[cfg(windows)]
mod imp {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Security::*;
    use windows_sys::Win32::System::StationsAndDesktops::*;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;

    /// `SECURITY_DESCRIPTOR_REVISION` is not re-exported by windows-sys.
    const SECURITY_DESCRIPTOR_REVISION: i32 = 1;

    /// `DESKTOP_ALL_ACCESS` from winuser.h: `STANDARD_RIGHTS_REQUIRED | desktop access rights`.
    /// The high half is 0x000F, not 0x001F — asking for `SYNCHRONIZE`, which a desktop object does
    /// not grant through its generic mapping, makes every `OpenDesktop`/`OpenInputDesktop` call fail
    /// with access denied.
    pub const DESKTOP_ALL_ACCESS: u32 = 0x000F_01FF;
    const UOI_NAME: i32 = 2;

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    unsafe fn name_of(h: HDESK) -> Option<String> {
        let mut buf = vec![0u16; 256];
        let mut needed = 0u32;
        let ok = unsafe {
            GetUserObjectInformationW(
                h as HANDLE,
                UOI_NAME,
                buf.as_mut_ptr() as *mut _,
                (buf.len() * 2) as u32,
                &mut needed,
            )
        };
        if ok == 0 {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }

    /// Binary SID of a local account by name.
    fn sid_of(account: &str) -> Option<Vec<u8>> {
        let w = wide(account);
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
            if sid_len == 0 {
                return None;
            }
            let mut sid = vec![0u8; sid_len as usize];
            let mut dom = vec![0u16; dom_len.max(1) as usize];
            if LookupAccountNameW(
                null(),
                w.as_ptr(),
                sid.as_mut_ptr() as PSID,
                &mut sid_len,
                dom.as_mut_ptr(),
                &mut dom_len,
                &mut kind,
            ) == 0
            {
                return None;
            }
            sid.truncate(sid_len as usize);
            Some(sid)
        }
    }

    /// `S-1-5-18` (SYSTEM), so the desktop stays administrable.
    fn system_sid() -> Option<Vec<u8>> {
        let mut len = 0u32;
        unsafe {
            CreateWellKnownSid(WinLocalSystemSid, null_mut(), null_mut(), &mut len);
            if len == 0 {
                return None;
            }
            let mut sid = vec![0u8; len as usize];
            if CreateWellKnownSid(
                WinLocalSystemSid,
                null_mut(),
                sid.as_mut_ptr() as PSID,
                &mut len,
            ) == 0
            {
                return None;
            }
            sid.truncate(len as usize);
            Some(sid)
        }
    }

    /// A security descriptor granting `sid`s full access, kept alive alongside its buffers.
    /// The buffers are `u64` so they satisfy the DWORD alignment the APIs require.
    #[allow(dead_code)]
    struct Sd {
        sd: Vec<u64>,
        acl: Vec<u64>,
        sids: Vec<Vec<u8>>,
    }

    impl Sd {
        fn new(mut sids: Vec<Vec<u8>>) -> Result<Sd, String> {
            if let Some(s) = system_sid() {
                sids.push(s);
            }
            let acl_len = std::mem::size_of::<ACL>()
                + sids
                    .iter()
                    .map(|s| std::mem::size_of::<ACCESS_ALLOWED_ACE>() - 4 + s.len())
                    .sum::<usize>();
            let mut sd = vec![0u64; std::mem::size_of::<SECURITY_DESCRIPTOR>().div_ceil(8) + 1];
            let mut acl = vec![0u64; acl_len.div_ceil(8) + 1];
            unsafe {
                let psd = sd.as_mut_ptr() as *mut SECURITY_DESCRIPTOR;
                let pacl = acl.as_mut_ptr() as *mut ACL;
                if InitializeSecurityDescriptor(psd as *mut _, SECURITY_DESCRIPTOR_REVISION as u32)
                    == 0
                {
                    return Err(format!(
                        "InitializeSecurityDescriptor failed: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                if InitializeAcl(pacl, acl_len as u32, ACL_REVISION) == 0 {
                    return Err(format!(
                        "InitializeAcl failed: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                for sid in &sids {
                    if AddAccessAllowedAceEx(
                        pacl,
                        ACL_REVISION,
                        0,
                        DESKTOP_ALL_ACCESS,
                        sid.as_ptr() as PSID,
                    ) == 0
                    {
                        return Err(format!(
                            "AddAccessAllowedAceEx failed: {}",
                            std::io::Error::last_os_error()
                        ));
                    }
                }
                if SetSecurityDescriptorDacl(psd as *mut _, 1, pacl, 0) == 0 {
                    return Err(format!(
                        "SetSecurityDescriptorDacl failed: {}",
                        std::io::Error::last_os_error()
                    ));
                }
            }
            Ok(Sd { sd, acl, sids })
        }

        fn attrs(&mut self) -> SECURITY_ATTRIBUTES {
            SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.sd.as_mut_ptr() as *mut _,
                bInheritHandle: 0,
            }
        }
    }

    /// An open desktop handle. `owned` distinguishes handles we must close from the one
    /// `GetThreadDesktop` returns (which must never be closed).
    pub struct Desktop {
        pub name: String,
        handle: HDESK,
        owned: bool,
    }

    unsafe impl Send for Desktop {}
    unsafe impl Sync for Desktop {}

    impl Desktop {
        pub fn handle(&self) -> HDESK {
            self.handle
        }

        /// Open an existing desktop, or create it granting `accounts` full access.
        ///
        /// The creator owns the object, so setting an explicit DACL at creation time is what
        /// lets a *different* account (the isolated user) connect to it later.
        pub fn open_or_create(name: &str, accounts: &[String]) -> Result<Desktop, String> {
            let w = wide(name);
            let h = unsafe { OpenDesktopW(w.as_ptr(), 0, 0, DESKTOP_ALL_ACCESS) };
            if !h.is_null() {
                return Ok(Desktop {
                    name: name.to_string(),
                    handle: h,
                    owned: true,
                });
            }
            let open_err = std::io::Error::last_os_error();
            let mut sids: Vec<Vec<u8>> = Vec::new();
            for a in accounts {
                match sid_of(a) {
                    Some(s) => sids.push(s),
                    None => return Err(format!("no such account `{a}`")),
                }
            }
            let mut sd = Sd::new(sids)?;
            let mut attrs = sd.attrs();
            let h = unsafe {
                CreateDesktopW(
                    w.as_ptr(),
                    null_mut(),
                    null_mut(),
                    0,
                    DESKTOP_ALL_ACCESS,
                    &mut attrs,
                )
            };
            // `sd` must outlive the call above; keep it alive until here.
            let _ = &sd;
            if h.is_null() {
                let e = std::io::Error::last_os_error();
                return Err(format!(
                    "CreateDesktopW(`{name}`) failed: {e} (OpenDesktop said: {open_err})"
                ));
            }
            Ok(Desktop {
                name: name.to_string(),
                handle: h,
                owned: true,
            })
        }

        /// The desktop the calling thread is attached to (its process's startup desktop).
        pub fn current() -> Result<Desktop, String> {
            let h = unsafe { GetThreadDesktop(GetCurrentThreadId()) };
            if h.is_null() {
                return Err(format!(
                    "GetThreadDesktop failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let name = unsafe { name_of(h) }.unwrap_or_else(|| "Default".into());
            Ok(Desktop {
                name,
                handle: h,
                owned: false,
            })
        }

        pub fn open(name: &str) -> Result<Desktop, String> {
            let w = wide(name);
            let h = unsafe { OpenDesktopW(w.as_ptr(), 0, 0, DESKTOP_ALL_ACCESS) };
            if h.is_null() {
                return Err(format!(
                    "OpenDesktop(`{name}`) failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(Desktop {
                name: name.to_string(),
                handle: h,
                owned: true,
            })
        }

        /// Name of the desktop that currently receives input in this session.
        ///
        /// Only the name is needed, and `DESKTOP_READOBJECTS` is the least access that allows it:
        /// the input desktop usually belongs to another security context (winlogon, another
        /// account), so anything broader can be denied and would silently report "not the input
        /// desktop" — which routes screen capture down the per-window path.
        pub fn input_name() -> Option<String> {
            let h = unsafe { OpenInputDesktop(0, 0, DESKTOP_READOBJECTS) };
            if h.is_null() {
                return None;
            }
            let name = unsafe { name_of(h) };
            unsafe { CloseDesktop(h) };
            name
        }

        /// Whether this desktop is the one that receives user input (BitBlt/SendInput work).
        pub fn is_input(&self) -> bool {
            Self::input_name().is_some_and(|n| n.eq_ignore_ascii_case(&self.name))
        }

        /// Make this desktop the session's visible/input desktop (takes over the screen).
        pub fn switch_to(&self) -> Result<(), String> {
            if unsafe { SwitchDesktop(self.handle) } != 0 {
                Ok(())
            } else {
                Err(format!(
                    "SwitchDesktop(`{}`) failed: {}",
                    self.name,
                    std::io::Error::last_os_error()
                ))
            }
        }
    }

    impl Drop for Desktop {
        fn drop(&mut self) {
            if self.owned && !self.handle.is_null() {
                unsafe { CloseDesktop(self.handle) };
            }
        }
    }

    /// Attaches the calling thread to a desktop for the life of the guard.
    ///
    /// Fails with `ERROR_BUSY` (170) when the thread already owns windows or hooks, so GUI work
    /// must run on a thread that has not created any (the server's request threads qualify).
    pub struct Attached {
        previous: HDESK,
        changed: bool,
    }

    impl Attached {
        pub fn enter(d: &Desktop) -> Result<Attached, String> {
            let previous = unsafe { GetThreadDesktop(GetCurrentThreadId()) };
            if previous == d.handle {
                return Ok(Attached {
                    previous,
                    changed: false,
                });
            }
            if unsafe { SetThreadDesktop(d.handle) } == 0 {
                let e = std::io::Error::last_os_error();
                return Err(format!(
                    "SetThreadDesktop(`{}`) failed: {e} (the thread already has windows or hooks)",
                    d.name
                ));
            }
            Ok(Attached {
                previous,
                changed: true,
            })
        }
    }

    impl Drop for Attached {
        fn drop(&mut self) {
            if self.changed && !self.previous.is_null() {
                unsafe { SetThreadDesktop(self.previous) };
            }
        }
    }
}

#[cfg(windows)]
#[allow(unused_imports)]
pub use imp::{Attached, DESKTOP_ALL_ACCESS, Desktop};

#[cfg(not(windows))]
mod imp {
    pub struct Desktop;

    impl Desktop {
        pub fn open_or_create(_name: &str, _accounts: &[String]) -> Result<Desktop, String> {
            Err("private desktops are only available on Windows".into())
        }
        pub fn current() -> Result<Desktop, String> {
            Err("private desktops are only available on Windows".into())
        }
        pub fn open(_name: &str) -> Result<Desktop, String> {
            Err("private desktops are only available on Windows".into())
        }
        pub fn input_name() -> Option<String> {
            None
        }
        pub fn is_input(&self) -> bool {
            false
        }
        pub fn switch_to(&self) -> Result<(), String> {
            Err("private desktops are only available on Windows".into())
        }
    }

    pub struct Attached;

    impl Attached {
        pub fn enter(_d: &Desktop) -> Result<Attached, String> {
            Err("private desktops are only available on Windows".into())
        }
    }
}

#[cfg(not(windows))]
#[allow(unused_imports)]
pub use imp::{Attached, Desktop};

#[cfg(test)]
mod tests {
    use super::private_name;

    #[test]
    fn names_are_desktop_safe() {
        assert_eq!(private_name("dsh-user1"), "dsh-dsh-user1");
        assert_eq!(private_name("User 1"), "dsh-user_1");
        assert_eq!(private_name("a\\b/c:d"), "dsh-a_b_c_d");
    }
}

#[cfg(all(test, windows))]
mod win_tests {
    use super::Desktop;

    /// Creates a real desktop, grants an ACE to the current account, attaches a thread to it
    /// and closes it again: the whole create/attach/lifetime path the private-desktop mode
    /// depends on.
    #[test]
    fn create_attach_and_close() {
        let user = std::env::var("USERNAME").expect("USERNAME");
        let name = format!("dsh-selftest-{}", std::process::id());
        let d = Desktop::open_or_create(&name, &[user]).expect("create desktop");
        {
            let guard = super::Attached::enter(&d).expect("attach to the new desktop");
            let current = Desktop::current().expect("current desktop");
            assert_eq!(current.name.to_ascii_lowercase(), name.to_ascii_lowercase());
            assert!(
                !d.is_input(),
                "a desktop nobody switched to must not be the input desktop"
            );
            drop(guard);
        }
        // The desktop object dies with its last handle.
        drop(d);
        assert!(
            Desktop::open(&name).is_err(),
            "the desktop should be destroyed once its last handle closes"
        );
    }
}
