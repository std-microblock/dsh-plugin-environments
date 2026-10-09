//! Running a command elevated, through the UAC consent dialog.
//!
//! The plugin never shells out to a third-party elevation tool: helpers such as `gsudo` elevate by
//! swapping the token of the calling process, which fails when that process has no console of its
//! own — the harness host redirects it — with `Failed to substitute token`. The shell's `runas`
//! verb asks the OS for elevation instead and only needs an interactive session.
//!
//! A `runas` process gets a console of its own and cannot inherit the caller's standard handles, so
//! the caller is expected to pass a command line that writes its own output to a file (the plugin
//! writes a temporary `.cmd` that redirects into a JSON file and reads it back afterwards).

use anyhow::{Context, Result, bail};
use std::ffi::OsStr;
use std::iter;
use std::os::windows::ffi::OsStrExt;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::System::Threading::{GetExitCodeProcess, INFINITE, WaitForSingleObject};
use windows_sys::Win32::UI::Shell::{
    SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

use crate::pty::quote_arg;

/// `ERROR_CANCELLED`: the consent dialog was dismissed (or the machine has no interactive session).
const ERROR_CANCELLED: u32 = 1223;

/// NUL-terminated UTF-16 for the `*W` APIs.
fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(iter::once(0)).collect()
}

/// The `lpParameters` of the elevated program: its arguments, quoted for the MSVC parser.
fn parameters(args: &[String]) -> String {
    let mut out = String::new();
    for (i, arg) in args.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        quote_arg(arg, &mut out);
    }
    out
}

/// Run `program` (with `args`) elevated, wait for it, and return its exit code.
pub fn run(program: &[String]) -> Result<i32> {
    let (file, args) = program
        .split_first()
        .context("elevate needs a program: dsh-env-server elevate -- <program> [args...]")?;
    let (verb, file, params) = (wide("runas"), wide(file), wide(&parameters(args)));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        // NOCLOSEPROCESS hands us the process so we can wait for it; NOASYNC makes the call
        // complete before it returns (without it the handle can arrive after we look at it).
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        lpVerb: verb.as_ptr(),
        lpFile: file.as_ptr(),
        lpParameters: params.as_ptr(),
        // The elevated program gets a console; never put it on the human's screen.
        nShow: SW_HIDE,
        ..Default::default()
    };
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        let code = unsafe { GetLastError() };
        if code == ERROR_CANCELLED {
            bail!(
                "administrator approval was refused (the UAC dialog was dismissed or could not be shown)"
            );
        }
        bail!(
            "could not elevate: {}",
            std::io::Error::from_raw_os_error(code as i32)
        );
    }
    let process: HANDLE = info.hProcess;
    if process.is_null() {
        // No handle to wait for: the verb was handled without starting a process.
        return Ok(0);
    }
    let mut code = 0u32;
    unsafe {
        WaitForSingleObject(process, INFINITE);
        GetExitCodeProcess(process, &mut code);
        CloseHandle(process);
    }
    Ok(code as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The plugin elevates `cmd.exe /d /c <temp script>`; the script path may contain spaces.
    #[test]
    fn parameters_are_quoted_for_the_program() {
        let args = ["/d", "/c", r"C:\Users\a b\Temp\dsh-env-elev-1.cmd"].map(String::from);
        assert_eq!(
            parameters(&args),
            r#"/d /c "C:\Users\a b\Temp\dsh-env-elev-1.cmd""#
        );
        assert_eq!(parameters(&[]), "");
        assert_eq!(parameters(&["serve".to_string()]), "serve");
    }
}
