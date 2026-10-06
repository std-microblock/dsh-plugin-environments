//! Pointer/keyboard input: portable action parsing and key tables, plus Windows injection.
//!
//! Coordinates on the wire are physical pixels of the virtual desktop (the plugin maps
//! screenshot coordinates back before sending them).

use crate::protocol::OpError;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
    X1,
    X2,
}

impl Button {
    fn parse(v: Option<&str>) -> Result<Self, OpError> {
        Ok(match v.unwrap_or("left") {
            "left" => Button::Left,
            "right" => Button::Right,
            "middle" => Button::Middle,
            "back" | "x1" => Button::X1,
            "forward" | "x2" => Button::X2,
            other => return Err(OpError::invalid(format!("unknown mouse button `{other}`"))),
        })
    }
}

/// One parsed action of a `sys.input` batch.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Move {
        x: f64,
        y: f64,
    },
    Click {
        at: Option<(f64, f64)>,
        button: Button,
        count: u32,
        modifiers: Vec<String>,
    },
    Down {
        at: Option<(f64, f64)>,
        button: Button,
    },
    Up {
        at: Option<(f64, f64)>,
        button: Button,
    },
    /// Press at the first point, move through the rest, release at the last.
    Drag {
        path: Vec<(f64, f64)>,
        button: Button,
        duration_ms: u64,
        modifiers: Vec<String>,
    },
    Scroll {
        at: Option<(f64, f64)>,
        dx: f64,
        dy: f64,
        modifiers: Vec<String>,
    },
    Type {
        text: String,
        delay_ms: u64,
    },
    Key {
        keys: Vec<String>,
        repeat: u32,
        hold_ms: u64,
    },
    KeyDown {
        keys: Vec<String>,
    },
    KeyUp {
        keys: Vec<String>,
    },
    Wait {
        ms: u64,
    },
}

fn num(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn point(v: &Value) -> Option<(f64, f64)> {
    Some((num(v, "x")?, num(v, "y")?))
}

fn modifiers(v: &Value) -> Result<Vec<String>, OpError> {
    match v.get("modifiers") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::String(s)) => parse_combo(s),
        Some(Value::Array(a)) => a
            .iter()
            .map(|m| {
                m.as_str()
                    .map(|s| s.trim().to_ascii_lowercase())
                    .ok_or_else(|| OpError::invalid("modifiers must be strings"))
            })
            .collect(),
        Some(_) => Err(OpError::invalid("modifiers must be a string or an array")),
    }
}

/// Split a key combo such as `"ctrl+shift+t"` or `"ctrl++"` into lower-cased key names.
pub fn parse_combo(combo: &str) -> Result<Vec<String>, OpError> {
    let combo = combo.trim();
    if combo.is_empty() {
        return Err(OpError::invalid("empty key"));
    }
    let mut keys = Vec::new();
    let (body, plus) = if combo == "+" {
        ("", true)
    } else if let Some(b) = combo.strip_suffix("++") {
        (b, true)
    } else {
        (combo, false)
    };
    for part in body.split('+') {
        let p = part.trim();
        if p.is_empty() {
            if body.is_empty() {
                continue;
            }
            return Err(OpError::invalid(format!("malformed key combo `{combo}`")));
        }
        keys.push(if p.chars().count() == 1 {
            p.to_string()
        } else {
            p.to_ascii_lowercase()
        });
    }
    if plus {
        keys.push("+".into());
    }
    Ok(keys)
}

/// Parse one wire action.
pub fn parse_action(v: &Value) -> Result<Action, OpError> {
    let kind = v.get("kind").and_then(Value::as_str).unwrap_or("");
    let button = || Button::parse(v.get("button").and_then(Value::as_str));
    let ms = |k: &str, d: u64| v.get(k).and_then(Value::as_u64).unwrap_or(d).min(60_000);
    let keys = || {
        parse_combo(
            v.get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| OpError::invalid(format!("{kind} needs `key`")))?,
        )
    };
    Ok(match kind {
        "move" => {
            let (x, y) = point(v).ok_or_else(|| OpError::invalid("move needs x and y"))?;
            Action::Move { x, y }
        }
        "click" => {
            let double = v.get("double").and_then(Value::as_bool).unwrap_or(false);
            let count = v
                .get("count")
                .and_then(Value::as_u64)
                .unwrap_or(if double { 2 } else { 1 })
                .clamp(1, 3) as u32;
            Action::Click {
                at: point(v),
                button: button()?,
                count,
                modifiers: modifiers(v)?,
            }
        }
        "down" | "mouse_down" => Action::Down {
            at: point(v),
            button: button()?,
        },
        "up" | "mouse_up" => Action::Up {
            at: point(v),
            button: button()?,
        },
        "drag" | "swipe" => {
            let mut path = Vec::new();
            if let Some(pts) = v.get("path").and_then(Value::as_array) {
                for p in pts {
                    let pt = match p {
                        Value::Array(a) if a.len() == 2 => a[0].as_f64().zip(a[1].as_f64()),
                        Value::Object(_) => point(p),
                        _ => None,
                    }
                    .ok_or_else(|| OpError::invalid("path points must be [x, y] or {x, y}"))?;
                    path.push(pt);
                }
            } else {
                if let Some(p) = point(v) {
                    path.push(p);
                }
                if let (Some(x2), Some(y2)) = (num(v, "x2"), num(v, "y2")) {
                    path.push((x2, y2));
                }
            }
            if path.len() < 2 {
                return Err(OpError::invalid(
                    "drag needs `path` with at least two points (or x, y, x2, y2)",
                ));
            }
            let d = v.get("durationMs").or_else(|| v.get("ms"));
            Action::Drag {
                path,
                button: button()?,
                duration_ms: d.and_then(Value::as_u64).unwrap_or(400).min(60_000),
                modifiers: modifiers(v)?,
            }
        }
        "scroll" => Action::Scroll {
            at: point(v),
            dx: num(v, "dx").unwrap_or(0.0).clamp(-100.0, 100.0),
            dy: num(v, "dy").unwrap_or(0.0).clamp(-100.0, 100.0),
            modifiers: modifiers(v)?,
        },
        "type" => Action::Type {
            text: v
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| OpError::invalid("type needs `text`"))?
                .to_string(),
            delay_ms: ms("delayMs", 0).min(1000),
        },
        "key" => Action::Key {
            keys: keys()?,
            repeat: v
                .get("repeat")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 100) as u32,
            hold_ms: ms("holdMs", 0),
        },
        "keyDown" | "key_down" => Action::KeyDown { keys: keys()? },
        "keyUp" | "key_up" => Action::KeyUp { keys: keys()? },
        "wait" => Action::Wait { ms: ms("ms", 0) },
        other => return Err(OpError::invalid(format!("unknown input action `{other}`"))),
    })
}

/// A virtual key with its extended-key flag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Vk {
    pub code: u16,
    pub extended: bool,
}

const fn vk(code: u16) -> Option<Vk> {
    Some(Vk {
        code,
        extended: false,
    })
}

const fn ext(code: u16) -> Option<Vk> {
    Some(Vk {
        code,
        extended: true,
    })
}

/// Named keys (layout-independent virtual-key codes). Single printable characters other than
/// ASCII letters/digits are layout-dependent and resolved by the Windows backend.
pub fn named_key(name: &str) -> Option<Vk> {
    let n = name.to_ascii_lowercase();
    let n = n.as_str();
    match n {
        "ctrl" | "control" | "lctrl" | "ctrl_left" => vk(0xA2),
        "rctrl" | "ctrl_right" => ext(0xA3),
        "shift" | "lshift" | "shift_left" => vk(0xA0),
        "rshift" | "shift_right" => vk(0xA1),
        "alt" | "menu" | "option" | "lalt" | "alt_left" => vk(0xA4),
        "ralt" | "altgr" | "alt_right" => ext(0xA5),
        "win" | "meta" | "super" | "cmd" | "command" | "windows" | "lwin" => ext(0x5B),
        "rwin" => ext(0x5C),
        "apps" | "contextmenu" | "context_menu" => ext(0x5D),
        "enter" | "return" => vk(0x0D),
        "numpad_enter" | "kp_enter" => ext(0x0D),
        "esc" | "escape" => vk(0x1B),
        "tab" => vk(0x09),
        "space" | "spacebar" => vk(0x20),
        "backspace" | "back_space" | "bs" => vk(0x08),
        "delete" | "del" => ext(0x2E),
        "insert" | "ins" => ext(0x2D),
        "home" => ext(0x24),
        "end" => ext(0x23),
        "pageup" | "page_up" | "pgup" | "prior" => ext(0x21),
        "pagedown" | "page_down" | "pgdn" | "next" => ext(0x22),
        "up" | "arrowup" | "arrow_up" => ext(0x26),
        "down" | "arrowdown" | "arrow_down" => ext(0x28),
        "left" | "arrowleft" | "arrow_left" => ext(0x25),
        "right" | "arrowright" | "arrow_right" => ext(0x27),
        "capslock" | "caps_lock" => vk(0x14),
        "numlock" | "num_lock" => ext(0x90),
        "scrolllock" | "scroll_lock" => vk(0x91),
        "pause" | "break" => vk(0x13),
        "printscreen" | "print_screen" | "prtsc" | "print" => ext(0x2C),
        "volumeup" | "volume_up" => ext(0xAF),
        "volumedown" | "volume_down" => ext(0xAE),
        "volumemute" | "volume_mute" | "mute" => ext(0xAD),
        "medianext" | "media_next" => ext(0xB0),
        "mediaprev" | "media_prev" | "media_previous" => ext(0xB1),
        "mediastop" | "media_stop" => ext(0xB2),
        "mediaplay" | "media_play_pause" | "playpause" => ext(0xB3),
        "browserback" | "browser_back" => ext(0xA6),
        "browserforward" | "browser_forward" => ext(0xA7),
        "browserrefresh" | "browser_refresh" => ext(0xA8),
        "multiply" | "numpad_multiply" => vk(0x6A),
        "add" | "numpad_add" => vk(0x6B),
        "subtract" | "numpad_subtract" => vk(0x6D),
        "decimal" | "numpad_decimal" => vk(0x6E),
        "divide" | "numpad_divide" => ext(0x6F),
        "plus" => vk(0xBB),
        "minus" => vk(0xBD),
        "comma" => vk(0xBC),
        "period" | "dot" => vk(0xBE),
        _ => {
            if let Some(d) = n.strip_prefix("numpad").or_else(|| n.strip_prefix("num"))
                && let Ok(d) = d.trim_start_matches('_').parse::<u16>()
                && d <= 9
            {
                return vk(0x60 + d);
            }
            if let Some(f) = n.strip_prefix('f').and_then(|d| d.parse::<u16>().ok())
                && (1..=24).contains(&f)
            {
                return vk(0x70 + f - 1);
            }
            let mut chars = n.chars();
            if let (Some(c), None) = (chars.next(), chars.next())
                && c.is_ascii_alphanumeric()
            {
                return vk(c.to_ascii_uppercase() as u16);
            }
            None
        }
    }
}

/// UTF-16 units of `text` grouped into key strokes: `Ok(unit)` for a KEYEVENTF_UNICODE unit,
/// `Err(vk)` for a control key (Enter for `\n` / `\r\n`, Tab for `\t`).
pub fn text_strokes(text: &str) -> Vec<Result<u16, u16>> {
    let mut out = Vec::new();
    let mut prev_cr = false;
    for unit in text.encode_utf16() {
        match unit {
            0x0A if prev_cr => {}
            0x0A | 0x0D => out.push(Err(0x0D)),
            0x09 => out.push(Err(0x09)),
            u => out.push(Ok(u)),
        }
        prev_cr = unit == 0x0D;
    }
    out
}

/// Wheel delta for a scroll of `notches` (positive dy = scroll down = negative wheel data).
pub fn wheel_delta(notches: f64, vertical: bool) -> i32 {
    let d = (notches * 120.0).round() as i32;
    if vertical { -d } else { d }
}

/// Points along `path` spaced about `step_ms` apart for a drag lasting `duration_ms`.
pub fn interpolate(path: &[(f64, f64)], duration_ms: u64, step_ms: u64) -> Vec<(f64, f64)> {
    if path.len() < 2 {
        return path.to_vec();
    }
    let lens: Vec<f64> = path
        .windows(2)
        .map(|w| ((w[1].0 - w[0].0).powi(2) + (w[1].1 - w[0].1).powi(2)).sqrt())
        .collect();
    let total: f64 = lens.iter().sum();
    let steps = ((duration_ms / step_ms.max(1)) as usize).clamp(path.len() - 1, 600);
    if total <= 0.0 {
        return vec![path[0], *path.last().unwrap_or(&path[0])];
    }
    let mut out = Vec::with_capacity(steps + 1);
    out.push(path[0]);
    for i in 1..=steps {
        let mut d = total * i as f64 / steps as f64;
        let mut seg = 0;
        while seg < lens.len() - 1 && d > lens[seg] {
            d -= lens[seg];
            seg += 1;
        }
        let t = if lens[seg] > 0.0 {
            (d / lens[seg]).min(1.0)
        } else {
            1.0
        };
        let (a, b) = (path[seg], path[seg + 1]);
        out.push((a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t));
    }
    out
}

#[cfg(windows)]
pub mod win {
    use super::*;
    use std::mem::{size_of, zeroed};
    use std::thread::sleep;
    use std::time::Duration;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    /// Keys and buttons currently held by this batch, released when it ends.
    #[derive(Default)]
    struct Held {
        keys: Vec<Vk>,
        buttons: Vec<Button>,
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
                "SendInput was blocked (UIPI: the target runs elevated, or a secure desktop is shown)",
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

    fn key_input(k: Vk, up: bool) -> INPUT {
        let scan = unsafe { MapVirtualKeyW(k.code as u32, MAPVK_VK_TO_VSC) } as u16;
        let mut flags = 0;
        if k.extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        let mut i: INPUT = unsafe { zeroed() };
        i.r#type = INPUT_KEYBOARD;
        i.Anonymous.ki = KEYBDINPUT {
            wVk: k.code,
            wScan: scan,
            dwFlags: flags,
            time: 0,
            dwExtraInfo: 0,
        };
        i
    }

    fn unicode_input(unit: u16, up: bool) -> INPUT {
        let mut i: INPUT = unsafe { zeroed() };
        i.r#type = INPUT_KEYBOARD;
        i.Anonymous.ki = KEYBDINPUT {
            wVk: 0,
            wScan: unit,
            dwFlags: KEYEVENTF_UNICODE | if up { KEYEVENTF_KEYUP } else { 0 },
            time: 0,
            dwExtraInfo: 0,
        };
        i
    }

    /// Resolve a key name, including layout-dependent single characters (`;`, `/`, ...).
    /// Returns the key plus the modifiers the current layout needs to produce it.
    fn resolve(name: &str) -> Result<(Vk, Vec<Vk>), OpError> {
        if let Some(k) = named_key(name) {
            return Ok((k, Vec::new()));
        }
        let mut chars = name.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            let mut buf = [0u16; 2];
            if c.encode_utf16(&mut buf).len() == 1 {
                let r = unsafe { VkKeyScanW(buf[0]) };
                if r != -1 {
                    let mut mods = Vec::new();
                    let shift = (r >> 8) & 0xff;
                    if shift & 1 != 0 {
                        mods.push(Vk {
                            code: VK_SHIFT,
                            extended: false,
                        });
                    }
                    if shift & 2 != 0 {
                        mods.push(Vk {
                            code: VK_CONTROL,
                            extended: false,
                        });
                    }
                    if shift & 4 != 0 {
                        mods.push(Vk {
                            code: VK_MENU,
                            extended: false,
                        });
                    }
                    return Ok((
                        Vk {
                            code: (r & 0xff) as u16,
                            extended: false,
                        },
                        mods,
                    ));
                }
            }
        }
        Err(OpError::invalid(format!("unknown key `{name}`")))
    }

    fn resolve_all(keys: &[String]) -> Result<Vec<Vk>, OpError> {
        let mut out = Vec::new();
        for k in keys {
            let (vk, mods) = resolve(k)?;
            for m in mods {
                if !out.contains(&m) {
                    out.push(m);
                }
            }
            out.push(vk);
        }
        Ok(out)
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

    /// Move the pointer exactly to (x, y) and emit a move event for hover handling.
    fn move_to(x: f64, y: f64) -> Result<(), OpError> {
        let (vx, vy, vw, vh) = virtual_screen();
        let (px, py) = (x.round() as i32, y.round() as i32);
        let nx = (((px - vx) as f64 + 0.5) * 65536.0 / vw.max(1) as f64) as i32;
        let ny = (((py - vy) as f64 + 0.5) * 65536.0 / vh.max(1) as f64) as i32;
        send(&[mouse(
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            nx,
            ny,
            0,
        )])?;
        unsafe { SetCursorPos(px, py) };
        Ok(())
    }

    fn button_flags(b: Button) -> (u32, u32, i32) {
        match b {
            Button::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 0),
            Button::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, 0),
            Button::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, 0),
            Button::X1 => (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, 1),
            Button::X2 => (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, 2),
        }
    }

    fn press_keys(held: &mut Held, keys: &[Vk]) -> Result<(), OpError> {
        let ins: Vec<INPUT> = keys.iter().map(|k| key_input(*k, false)).collect();
        send(&ins)?;
        held.keys.extend_from_slice(keys);
        Ok(())
    }

    fn release_keys(held: &mut Held, keys: &[Vk]) -> Result<(), OpError> {
        let ins: Vec<INPUT> = keys.iter().rev().map(|k| key_input(*k, true)).collect();
        held.keys.retain(|h| !keys.contains(h));
        send(&ins)
    }

    fn with_modifiers(
        held: &mut Held,
        mods: &[String],
        f: impl FnOnce(&mut Held) -> Result<(), OpError>,
    ) -> Result<(), OpError> {
        let vks = resolve_all(mods)?;
        press_keys(held, &vks)?;
        let r = f(held);
        release_keys(held, &vks)?;
        r
    }

    fn perform(action: &Action, held: &mut Held) -> Result<(), OpError> {
        match action {
            Action::Move { x, y } => move_to(*x, *y),
            Action::Click {
                at,
                button,
                count,
                modifiers,
            } => {
                if let Some((x, y)) = at {
                    move_to(*x, *y)?;
                }
                with_modifiers(held, modifiers, |_| {
                    let (down, up, data) = button_flags(*button);
                    let mut ins = Vec::new();
                    for _ in 0..*count {
                        ins.push(mouse(down, 0, 0, data));
                        ins.push(mouse(up, 0, 0, data));
                    }
                    send(&ins)
                })
            }
            Action::Down { at, button } => {
                if let Some((x, y)) = at {
                    move_to(*x, *y)?;
                }
                let (down, _, data) = button_flags(*button);
                send(&[mouse(down, 0, 0, data)])?;
                held.buttons.push(*button);
                Ok(())
            }
            Action::Up { at, button } => {
                if let Some((x, y)) = at {
                    move_to(*x, *y)?;
                }
                let (_, up, data) = button_flags(*button);
                held.buttons.retain(|b| b != button);
                send(&[mouse(up, 0, 0, data)])
            }
            Action::Drag {
                path,
                button,
                duration_ms,
                modifiers,
            } => with_modifiers(held, modifiers, |held| {
                const STEP: u64 = 15;
                let pts = interpolate(path, *duration_ms, STEP);
                let (down, up, data) = button_flags(*button);
                move_to(pts[0].0, pts[0].1)?;
                send(&[mouse(down, 0, 0, data)])?;
                held.buttons.push(*button);
                let pause = Duration::from_millis(*duration_ms / pts.len().max(1) as u64);
                // A short initial pause lets drag-and-drop sources arm before the first move.
                sleep(Duration::from_millis(40));
                for (x, y) in &pts[1..] {
                    move_to(*x, *y)?;
                    sleep(pause);
                }
                sleep(Duration::from_millis(40));
                held.buttons.retain(|b| b != button);
                send(&[mouse(up, 0, 0, data)])
            }),
            Action::Scroll {
                at,
                dx,
                dy,
                modifiers,
            } => {
                if let Some((x, y)) = at {
                    move_to(*x, *y)?;
                }
                with_modifiers(held, modifiers, |_| {
                    // Send whole notches one by one: many apps ignore or mis-handle huge deltas.
                    for (amount, vertical) in [(*dy, true), (*dx, false)] {
                        let flag = if vertical {
                            MOUSEEVENTF_WHEEL
                        } else {
                            MOUSEEVENTF_HWHEEL
                        };
                        let whole = amount.trunc();
                        for _ in 0..(whole.abs() as u32) {
                            send(&[mouse(flag, 0, 0, wheel_delta(whole.signum(), vertical))])?;
                            sleep(Duration::from_millis(15));
                        }
                        let frac = amount - whole;
                        if frac.abs() > 0.01 {
                            send(&[mouse(flag, 0, 0, wheel_delta(frac, vertical))])?;
                        }
                    }
                    Ok(())
                })
            }
            Action::Type { text, delay_ms } => {
                let strokes = text_strokes(text);
                // Small chunks keep slow targets from dropping characters.
                for chunk in strokes.chunks(if *delay_ms > 0 { 1 } else { 32 }) {
                    let mut ins = Vec::with_capacity(chunk.len() * 2);
                    for s in chunk {
                        match *s {
                            Ok(unit) => {
                                ins.push(unicode_input(unit, false));
                                ins.push(unicode_input(unit, true));
                            }
                            Err(code) => {
                                let k = Vk {
                                    code,
                                    extended: false,
                                };
                                ins.push(key_input(k, false));
                                ins.push(key_input(k, true));
                            }
                        }
                    }
                    send(&ins)?;
                    sleep(Duration::from_millis((*delay_ms).max(4)));
                }
                Ok(())
            }
            Action::Key {
                keys,
                repeat,
                hold_ms,
            } => {
                let vks = resolve_all(keys)?;
                for _ in 0..*repeat {
                    press_keys(held, &vks)?;
                    if *hold_ms > 0 {
                        sleep(Duration::from_millis(*hold_ms));
                    }
                    release_keys(held, &vks)?;
                    if *repeat > 1 {
                        sleep(Duration::from_millis(10));
                    }
                }
                Ok(())
            }
            Action::KeyDown { keys } => {
                let vks = resolve_all(keys)?;
                press_keys(held, &vks)
            }
            Action::KeyUp { keys } => {
                let vks = resolve_all(keys)?;
                release_keys(held, &vks)
            }
            Action::Wait { ms } => {
                sleep(Duration::from_millis(*ms));
                Ok(())
            }
        }
    }

    /// Run a batch in order. Keys and buttons still held at the end (or after an error)
    /// are released so nothing stays stuck on the user's desktop.
    pub fn run(actions: &[Action]) -> Result<(), OpError> {
        let mut held = Held::default();
        let mut result = Ok(());
        for a in actions {
            if let Err(e) = perform(a, &mut held) {
                result = Err(e);
                break;
            }
        }
        let keys = std::mem::take(&mut held.keys);
        let _ = send(
            &keys
                .iter()
                .rev()
                .map(|k| key_input(*k, true))
                .collect::<Vec<_>>(),
        );
        for b in std::mem::take(&mut held.buttons) {
            let (_, up, data) = button_flags(b);
            let _ = send(&[mouse(up, 0, 0, data)]);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn combos() {
        assert_eq!(parse_combo("Ctrl+Shift+T").unwrap(), ["ctrl", "shift", "T"]);
        assert_eq!(parse_combo("ctrl++").unwrap(), ["ctrl", "+"]);
        assert_eq!(parse_combo("+").unwrap(), ["+"]);
        assert_eq!(parse_combo(" enter ").unwrap(), ["enter"]);
        assert!(parse_combo("ctrl++a").is_err());
        assert!(parse_combo("").is_err());
    }

    #[test]
    fn key_table() {
        assert_eq!(named_key("a").unwrap().code, b'A' as u16);
        assert_eq!(named_key("A").unwrap().code, b'A' as u16);
        assert_eq!(named_key("7").unwrap().code, b'7' as u16);
        assert_eq!(named_key("F5").unwrap().code, 0x74);
        assert_eq!(named_key("f24").unwrap().code, 0x87);
        assert!(named_key("f25").is_none());
        assert_eq!(named_key("numpad3").unwrap().code, 0x63);
        assert!(named_key("left").unwrap().extended);
        assert!(!named_key("enter").unwrap().extended);
        assert!(named_key("numpad_enter").unwrap().extended);
        assert_eq!(named_key("Ctrl").unwrap().code, 0xA2);
        assert!(named_key("nosuchkey").is_none());
        assert!(named_key(";").is_none());
    }

    #[test]
    fn actions() {
        let a = parse_action(&json!({"kind":"click","x":10,"y":20,"double":true})).unwrap();
        assert_eq!(
            a,
            Action::Click {
                at: Some((10.0, 20.0)),
                button: Button::Left,
                count: 2,
                modifiers: vec![]
            }
        );
        let a = parse_action(
            &json!({"kind":"click","button":"right","count":9,"modifiers":"ctrl+shift"}),
        )
        .unwrap();
        assert_eq!(
            a,
            Action::Click {
                at: None,
                button: Button::Right,
                count: 3,
                modifiers: vec!["ctrl".into(), "shift".into()]
            }
        );
        let a =
            parse_action(&json!({"kind":"drag","path":[[0,0],{"x":5,"y":5}],"ms":100})).unwrap();
        assert!(matches!(a, Action::Drag { ref path, duration_ms: 100, .. } if path.len() == 2));
        let a = parse_action(&json!({"kind":"swipe","x":1,"y":2,"x2":3,"y2":4})).unwrap();
        assert!(matches!(a, Action::Drag { ref path, .. } if path == &[(1.0, 2.0), (3.0, 4.0)]));
        assert!(parse_action(&json!({"kind":"drag","x":1,"y":2})).is_err());
        assert!(parse_action(&json!({"kind":"move","x":1})).is_err());
        assert!(parse_action(&json!({"kind":"teleport"})).is_err());
        assert!(parse_action(&json!({"kind":"click","button":"fourth"})).is_err());
        let a = parse_action(&json!({"kind":"key","key":"ctrl+s","repeat":3})).unwrap();
        assert_eq!(
            a,
            Action::Key {
                keys: vec!["ctrl".into(), "s".into()],
                repeat: 3,
                hold_ms: 0
            }
        );
        assert_eq!(
            parse_action(&json!({"kind":"wait","ms":999999})).unwrap(),
            Action::Wait { ms: 60_000 }
        );
    }

    #[test]
    fn text_to_strokes() {
        // "a\r\nb\t😀" → a, Enter, b, Tab, surrogate pair
        let s = text_strokes("a\r\nb\t\u{1F600}");
        assert_eq!(
            s,
            vec![
                Ok(b'a' as u16),
                Err(0x0D),
                Ok(b'b' as u16),
                Err(0x09),
                Ok(0xD83D),
                Ok(0xDE00)
            ]
        );
        assert_eq!(
            text_strokes("中\n\n"),
            vec![Ok(0x4E2D), Err(0x0D), Err(0x0D)]
        );
    }

    #[test]
    fn wheel_and_path() {
        assert_eq!(wheel_delta(1.0, true), -120);
        assert_eq!(wheel_delta(-2.0, true), 240);
        assert_eq!(wheel_delta(1.0, false), 120);
        let pts = interpolate(&[(0.0, 0.0), (100.0, 0.0), (100.0, 100.0)], 200, 10);
        assert_eq!(pts.len(), 21);
        assert_eq!(pts[0], (0.0, 0.0));
        assert_eq!(*pts.last().unwrap(), (100.0, 100.0));
        assert!((pts[10].0 - 100.0).abs() < 1e-9 && pts[10].1.abs() < 1e-9);
        assert_eq!(interpolate(&[(1.0, 1.0), (1.0, 1.0)], 100, 10).len(), 2);
    }
}
