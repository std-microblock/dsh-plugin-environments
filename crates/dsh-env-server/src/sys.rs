//! System information, screenshots and input injection.

use crate::protocol::{Args, OpError, OpResult};
use serde_json::{Value, json};
use std::path::Path;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn os_name() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else {
        std::env::consts::OS
    }
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_else(|| "unknown".into())
}

fn user() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "unknown".into())
}

fn home() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| {
            if cfg!(windows) {
                "C:\\".into()
            } else {
                "/".into()
            }
        })
}

pub fn which(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(|s| s.to_ascii_lowercase())
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path) {
        for ext in &exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// The shell program and its leading arguments for running a command string.
pub fn shell_invocation() -> (String, Vec<String>) {
    if cfg!(windows) {
        let prog = if which("pwsh").is_some() {
            "pwsh.exe"
        } else {
            "powershell.exe"
        };
        (
            prog.into(),
            vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
            ],
        )
    } else {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| Path::new(s).exists())
            .unwrap_or_else(|| "/bin/sh".into());
        (shell, vec!["-c".into()])
    }
}

pub fn caps() -> Vec<&'static str> {
    let mut caps = vec![
        "fs",
        "glob",
        "grep",
        "proc",
        "pty",
        "tcp",
        "tcp-listen",
        "udp",
        "udp-listen",
    ];
    if cfg!(windows) {
        caps.push("screenshot");
        caps.push("input");
    }
    caps
}

pub fn info(cwd: &Path) -> Value {
    let (shell, _) = shell_invocation();
    json!({
        "version": VERSION,
        "os": os_name(),
        "family": if cfg!(windows) { "windows" } else { "posix" },
        "arch": std::env::consts::ARCH,
        "hostname": hostname(),
        "user": user(),
        "home": home(),
        "cwd": cwd.to_string_lossy(),
        "pathSep": std::path::MAIN_SEPARATOR.to_string(),
        "shell": shell,
        "caps": caps(),
    })
}

pub async fn screenshot(a: Args<'_>) -> OpResult {
    let _display = a.opt_u64("display");
    #[cfg(windows)]
    {
        let (w, h, png) = tokio::task::spawn_blocking(win::capture)
            .await
            .map_err(|e| OpError::new("EIO", e.to_string()))??;
        Ok((json!({"width": w, "height": h, "format": "png"}), png))
    }
    #[cfg(not(windows))]
    {
        Err(OpError::unsupported(
            "screenshots are only supported on Windows hosts",
        ))
    }
}

pub async fn input(a: Args<'_>) -> OpResult {
    let actions =
        a.0.get("actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
    #[cfg(windows)]
    {
        for action in actions {
            if action.get("kind").and_then(Value::as_str) == Some("wait") {
                let ms = action
                    .get("ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    .min(60_000);
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                continue;
            }
            tokio::task::spawn_blocking(move || win::perform(&action))
                .await
                .map_err(|e| OpError::new("EIO", e.to_string()))??;
        }
        Ok((json!({}), Vec::new()))
    }
    #[cfg(not(windows))]
    {
        let _ = actions;
        Err(OpError::unsupported(
            "input injection is only supported on Windows hosts",
        ))
    }
}

#[cfg(windows)]
pub mod win {
    use super::*;
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    pub fn init_dpi() {
        unsafe {
            windows_sys::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
                windows_sys::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            );
        }
    }

    fn virtual_screen() -> (i32, i32, i32, i32) {
        unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        }
    }

    pub fn capture() -> Result<(u32, u32, Vec<u8>), OpError> {
        let (x, y, w, h) = virtual_screen();
        if w <= 0 || h <= 0 {
            return Err(OpError::new(
                "EIO",
                "no visible desktop (is this an interactive session?)",
            ));
        }
        let mut bgra = vec![0u8; (w * h * 4) as usize];
        unsafe {
            let screen = GetDC(std::ptr::null_mut());
            if screen.is_null() {
                return Err(OpError::new("EIO", "GetDC failed"));
            }
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(mem, bmp as _);
            let ok = BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY | CAPTUREBLT);
            let mut bi: BITMAPINFO = zeroed();
            bi.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
            bi.bmiHeader.biWidth = w;
            bi.bmiHeader.biHeight = -h;
            bi.bmiHeader.biPlanes = 1;
            bi.bmiHeader.biBitCount = 32;
            bi.bmiHeader.biCompression = BI_RGB;
            let lines = GetDIBits(
                mem,
                bmp,
                0,
                h as u32,
                bgra.as_mut_ptr() as _,
                &mut bi,
                DIB_RGB_COLORS,
            );
            SelectObject(mem, old);
            DeleteObject(bmp as _);
            DeleteDC(mem);
            ReleaseDC(std::ptr::null_mut(), screen);
            if ok == 0 || lines == 0 {
                return Err(OpError::new(
                    "EIO",
                    "screen capture failed (desktop locked or not interactive?)",
                ));
            }
        }
        let mut rgba = Vec::with_capacity(bgra.len() / 4 * 3);
        for px in bgra.as_chunks::<4>().0 {
            rgba.extend_from_slice(&[px[2], px[1], px[0]]);
        }
        drop(bgra);
        let out = crate::util::png_rgb(w as u32, h as u32, &rgba);
        Ok((w as u32, h as u32, out))
    }

    fn send(inputs: &[INPUT]) -> Result<(), OpError> {
        if inputs.is_empty() {
            return Ok(());
        }
        let n = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                size_of::<INPUT>() as i32,
            )
        };
        if n as usize != inputs.len() {
            return Err(OpError::new(
                "EACCES",
                "SendInput was blocked (UIPI or secure desktop)",
            ));
        }
        Ok(())
    }

    fn mouse(flags: u32, dx: i32, dy: i32, data: i32) -> INPUT {
        let mut i: INPUT = unsafe { zeroed() };
        i.r#type = INPUT_MOUSE;
        i.Anonymous.mi = MOUSEINPUT {
            dx,
            dy,
            mouseData: data as _,
            dwFlags: flags,
            time: 0,
            dwExtraInfo: 0,
        };
        i
    }

    fn key(vk: u16, scan: u16, flags: u32) -> INPUT {
        let mut i: INPUT = unsafe { zeroed() };
        i.r#type = INPUT_KEYBOARD;
        i.Anonymous.ki = KEYBDINPUT {
            wVk: vk,
            wScan: scan,
            dwFlags: flags,
            time: 0,
            dwExtraInfo: 0,
        };
        i
    }

    fn move_to(x: f64, y: f64) -> INPUT {
        let (vx, vy, vw, vh) = virtual_screen();
        let nx = (((x - vx as f64) * 65535.0) / ((vw - 1).max(1) as f64)).round() as i32;
        let ny = (((y - vy as f64) * 65535.0) / ((vh - 1).max(1) as f64)).round() as i32;
        mouse(
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            nx,
            ny,
            0,
        )
    }

    fn vk_for(name: &str) -> Option<u16> {
        let n = name.to_ascii_lowercase();
        let vk = match n.as_str() {
            "ctrl" | "control" => VK_CONTROL,
            "shift" => VK_SHIFT,
            "alt" | "menu" => VK_MENU,
            "win" | "meta" | "super" | "cmd" => VK_LWIN,
            "enter" | "return" => VK_RETURN,
            "esc" | "escape" => VK_ESCAPE,
            "tab" => VK_TAB,
            "space" => VK_SPACE,
            "backspace" => VK_BACK,
            "delete" | "del" => VK_DELETE,
            "insert" => VK_INSERT,
            "home" => VK_HOME,
            "end" => VK_END,
            "pageup" => VK_PRIOR,
            "pagedown" => VK_NEXT,
            "up" => VK_UP,
            "down" => VK_DOWN,
            "left" => VK_LEFT,
            "right" => VK_RIGHT,
            "capslock" => VK_CAPITAL,
            "printscreen" => VK_SNAPSHOT,
            _ => {
                if let Some(f) = n.strip_prefix('f').and_then(|d| d.parse::<u16>().ok())
                    && (1..=24).contains(&f)
                {
                    return Some(VK_F1 + f - 1);
                }
                let chars: Vec<char> = n.chars().collect();
                if chars.len() == 1 {
                    let c = chars[0];
                    if c.is_ascii_alphanumeric() {
                        return Some(c.to_ascii_uppercase() as u16);
                    }
                    let r = unsafe { VkKeyScanW(c as u16) };
                    if r != -1 {
                        return Some((r & 0xff) as u16);
                    }
                }
                return None;
            }
        };
        Some(vk)
    }

    pub fn perform(action: &Value) -> Result<(), OpError> {
        let kind = action.get("kind").and_then(Value::as_str).unwrap_or("");
        let fx = action.get("x").and_then(Value::as_f64);
        let fy = action.get("y").and_then(Value::as_f64);
        let mut inputs = Vec::new();
        match kind {
            "move" => {
                let (Some(x), Some(y)) = (fx, fy) else {
                    return Err(OpError::invalid("move needs x and y"));
                };
                inputs.push(move_to(x, y));
            }
            "click" => {
                if let (Some(x), Some(y)) = (fx, fy) {
                    inputs.push(move_to(x, y));
                }
                let (down, up) = match action
                    .get("button")
                    .and_then(Value::as_str)
                    .unwrap_or("left")
                {
                    "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                    "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
                    _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
                };
                let times = if action
                    .get("double")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    2
                } else {
                    1
                };
                for _ in 0..times {
                    inputs.push(mouse(down, 0, 0, 0));
                    inputs.push(mouse(up, 0, 0, 0));
                }
            }
            "scroll" => {
                if let (Some(x), Some(y)) = (fx, fy) {
                    inputs.push(move_to(x, y));
                }
                let dy = action.get("dy").and_then(Value::as_f64).unwrap_or(0.0);
                let dx = action.get("dx").and_then(Value::as_f64).unwrap_or(0.0);
                if dy != 0.0 {
                    inputs.push(mouse(MOUSEEVENTF_WHEEL, 0, 0, (-dy * 120.0) as i32));
                }
                if dx != 0.0 {
                    inputs.push(mouse(MOUSEEVENTF_HWHEEL, 0, 0, (dx * 120.0) as i32));
                }
            }
            "type" => {
                let text = action.get("text").and_then(Value::as_str).unwrap_or("");
                for unit in text.encode_utf16() {
                    if unit == '\n' as u16 {
                        inputs.push(key(VK_RETURN, 0, 0));
                        inputs.push(key(VK_RETURN, 0, KEYEVENTF_KEYUP));
                        continue;
                    }
                    inputs.push(key(0, unit, KEYEVENTF_UNICODE));
                    inputs.push(key(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
                }
            }
            "key" => {
                let combo = action.get("key").and_then(Value::as_str).unwrap_or("");
                let mut vks = Vec::new();
                for part in combo.split('+').map(str::trim).filter(|p| !p.is_empty()) {
                    vks.push(
                        vk_for(part)
                            .ok_or_else(|| OpError::invalid(format!("unknown key `{part}`")))?,
                    );
                }
                for vk in &vks {
                    inputs.push(key(*vk, 0, 0));
                }
                for vk in vks.iter().rev() {
                    inputs.push(key(*vk, 0, KEYEVENTF_KEYUP));
                }
            }
            other => return Err(OpError::invalid(format!("unknown input action `{other}`"))),
        }
        send(&inputs)
    }
}
