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
        caps.extend(["screenshot", "input", "displays", "windows"]);
        if which("powershell").is_some() {
            caps.push("uia");
        }
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

fn blocking_err(e: tokio::task::JoinError) -> OpError {
    OpError::new("EIO", e.to_string())
}

#[cfg_attr(not(windows), allow(dead_code))]
fn capture_spec(a: &Args<'_>) -> Result<crate::screen::CaptureSpec, OpError> {
    let rect = match a.0.get("rect") {
        None | Some(Value::Null) => None,
        Some(r) => {
            let g = |k: &str| {
                r.get(k)
                    .and_then(Value::as_f64)
                    .map(|v| v.round() as i32)
                    .ok_or_else(|| OpError::invalid(format!("rect.{k} is required")))
            };
            let rect = crate::screen::Rect {
                x: g("x")?,
                y: g("y")?,
                w: g("width")?,
                h: g("height")?,
            };
            if rect.w <= 0 || rect.h <= 0 {
                return Err(OpError::invalid("rect must have a positive size"));
            }
            Some(rect)
        }
    };
    Ok(crate::screen::CaptureSpec {
        display: a.0.get("display").and_then(Value::as_i64),
        rect,
        window: a.opt_u64("window"),
        cursor: a.bool("cursor", false),
    })
}

/// `sys.screenshot`: capture a display, a rectangle or a window; downscale to
/// `maxWidth` x `maxHeight`; return a PNG payload.
pub async fn screenshot(a: Args<'_>) -> OpResult {
    #[cfg(windows)]
    {
        let spec = capture_spec(&a)?;
        let desk = crate::desktop::Desktop::current().map_err(|e| OpError::new("EIO", e))?;
        let max_w = a.opt_u64("maxWidth").unwrap_or(0).min(16384) as u32;
        let max_h = a.opt_u64("maxHeight").unwrap_or(0).min(16384) as u32;
        tokio::task::spawn_blocking(move || {
            let c = crate::screen::win::capture(&spec, &desk)?;
            let (sw, sh) = (c.rect.w as u32, c.rect.h as u32);
            let (w, h) = crate::screen::fit(sw, sh, max_w, max_h);
            let rgb = crate::screen::resize_rgb(&c.rgb, sw, sh, w, h);
            let png = crate::util::png_rgb(w, h, &rgb);
            let mut meta = json!({
                "width": w,
                "height": h,
                "format": "png",
                "x": c.rect.x,
                "y": c.rect.y,
                "srcWidth": sw,
                "srcHeight": sh,
            });
            if let Some((x, y)) = c.cursor {
                meta["cursor"] = json!({"x": x, "y": y});
            }
            Ok((meta, png))
        })
        .await
        .map_err(blocking_err)?
    }
    #[cfg(not(windows))]
    {
        let _ = a;
        Err(OpError::unsupported(
            "screenshots are only supported on Windows hosts",
        ))
    }
}

/// `sys.input`: run a batch of pointer/keyboard actions in order.
pub async fn input(a: Args<'_>) -> OpResult {
    let actions =
        a.0.get("actions")
            .and_then(Value::as_array)
            .ok_or_else(|| OpError::invalid("actions must be an array"))?
            .iter()
            .map(crate::input::parse_action)
            .collect::<Result<Vec<_>, _>>()?;
    #[cfg(windows)]
    {
        let desk = crate::desktop::Desktop::current().map_err(|e| OpError::new("EIO", e))?;
        tokio::task::spawn_blocking(move || crate::input::win::run(&actions, &desk))
            .await
            .map_err(blocking_err)??;
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

/// `sys.displays`: monitors with their physical rectangles and DPI.
pub async fn displays(_a: Args<'_>) -> OpResult {
    #[cfg(windows)]
    {
        let v = tokio::task::spawn_blocking(crate::screen::win::displays_json)
            .await
            .map_err(blocking_err)?;
        Ok((v, Vec::new()))
    }
    #[cfg(not(windows))]
    {
        Err(OpError::unsupported(
            "displays are only listed on Windows hosts",
        ))
    }
}

/// `sys.windows`: top-level windows in z-order.
pub async fn windows(a: Args<'_>) -> OpResult {
    #[cfg(windows)]
    {
        let all = a.bool("all", false);
        let desk = crate::desktop::Desktop::current().map_err(|e| OpError::new("EIO", e))?;
        let v = tokio::task::spawn_blocking(move || crate::screen::win::windows(all, &desk))
            .await
            .map_err(blocking_err)??;
        Ok((v, Vec::new()))
    }
    #[cfg(not(windows))]
    {
        let _ = a;
        Err(OpError::unsupported(
            "windows are only listed on Windows hosts",
        ))
    }
}

/// `sys.window`: focus / minimize / maximize / restore / close / move a window.
pub async fn window(a: Args<'_>) -> OpResult {
    #[cfg(windows)]
    {
        let h = a.u64("hwnd")?;
        let action = a.str("action")?.to_string();
        let rect = match (
            a.opt_f64("x"),
            a.opt_f64("y"),
            a.opt_f64("width"),
            a.opt_f64("height"),
        ) {
            (Some(x), Some(y), Some(w), Some(h)) => Some(crate::screen::Rect {
                x: x.round() as i32,
                y: y.round() as i32,
                w: w.round() as i32,
                h: h.round() as i32,
            }),
            _ => None,
        };
        let desk = crate::desktop::Desktop::current().map_err(|e| OpError::new("EIO", e))?;
        let v = tokio::task::spawn_blocking(move || {
            crate::screen::win::window_action(h, &action, rect, &desk)
        })
        .await
        .map_err(blocking_err)??;
        Ok((v, Vec::new()))
    }
    #[cfg(not(windows))]
    {
        let _ = a;
        Err(OpError::unsupported(
            "windows can only be managed on Windows hosts",
        ))
    }
}

#[cfg(windows)]
pub mod win {
    pub fn init_dpi() {
        unsafe {
            windows_sys::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
                windows_sys::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            );
        }
    }
}
