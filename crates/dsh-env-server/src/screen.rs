//! Screen capture (displays, regions, windows), downscaling and window management.

/// A rectangle in physical virtual-desktop pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn intersect(&self, o: &Rect) -> Option<Rect> {
        let x0 = self.x.max(o.x);
        let y0 = self.y.max(o.y);
        let x1 = (self.x + self.w).min(o.x + o.w);
        let y1 = (self.y + self.h).min(o.y + o.h);
        (x1 > x0 && y1 > y0).then_some(Rect {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        })
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({"x": self.x, "y": self.y, "width": self.w, "height": self.h})
    }
}

/// Output size for a `w`×`h` source limited to `max_w`×`max_h` (0 = unlimited), keeping the
/// aspect ratio and never enlarging.
pub fn fit(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let mut s = 1.0f64;
    if max_w > 0 && w > max_w {
        s = s.min(max_w as f64 / w as f64);
    }
    if max_h > 0 && h > max_h {
        s = s.min(max_h as f64 / h as f64);
    }
    if s >= 1.0 {
        return (w, h);
    }
    (
        ((w as f64 * s).round() as u32).max(1),
        ((h as f64 * s).round() as u32).max(1),
    )
}

/// Per output pixel, the source index range and fixed-point (16.16) weights of an area filter.
fn axis_weights(src: u32, dst: u32) -> Vec<(usize, Vec<u32>)> {
    let scale = src as f64 / dst as f64;
    (0..dst)
        .map(|i| {
            let a = i as f64 * scale;
            let b = ((i + 1) as f64 * scale).min(src as f64);
            let first = a.floor() as usize;
            let last = (b.ceil() as usize).max(first + 1).min(src as usize);
            let mut w: Vec<f64> = (first..last)
                .map(|j| ((j + 1) as f64).min(b) - (j as f64).max(a))
                .map(|c| c.max(0.0))
                .collect();
            let sum: f64 = w.iter().sum();
            if sum <= 0.0 {
                w = vec![1.0];
            }
            let sum: f64 = w.iter().sum();
            (
                first,
                w.iter()
                    .map(|c| (c / sum * 65536.0).round() as u32)
                    .collect(),
            )
        })
        .collect()
}

/// Area-average resample of 8-bit RGB pixels (good for downscaling text-heavy screens).
pub fn resize_rgb(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
    if sw == dw && sh == dh {
        return src.to_vec();
    }
    let xs = axis_weights(sw, dw);
    let ys = axis_weights(sh, dh);
    // Horizontal pass into u32 rows (values scaled by 65536).
    let mut tmp = vec![0u32; dw as usize * sh as usize * 3];
    for y in 0..sh as usize {
        let row = &src[y * sw as usize * 3..(y + 1) * sw as usize * 3];
        let out = &mut tmp[y * dw as usize * 3..(y + 1) * dw as usize * 3];
        for (x, (first, w)) in xs.iter().enumerate() {
            let mut acc = [0u32; 3];
            for (k, wk) in w.iter().enumerate() {
                let p = (first + k) * 3;
                for c in 0..3 {
                    acc[c] += row[p + c] as u32 * wk;
                }
            }
            out[x * 3..x * 3 + 3].copy_from_slice(&acc);
        }
    }
    let mut out = vec![0u8; dw as usize * dh as usize * 3];
    let stride = dw as usize * 3;
    for (y, (first, w)) in ys.iter().enumerate() {
        let o = &mut out[y * stride..(y + 1) * stride];
        for (i, px) in o.iter_mut().enumerate() {
            let mut acc = 0u64;
            for (k, wk) in w.iter().enumerate() {
                acc += tmp[(first + k) * stride + i] as u64 * *wk as u64;
            }
            *px = ((acc + (1 << 31)) >> 32).min(255) as u8;
        }
    }
    out
}

/// Capture parameters of `sys.screenshot`.
#[derive(Clone, Debug, Default)]
pub struct CaptureSpec {
    pub display: Option<i64>,
    pub rect: Option<Rect>,
    pub window: Option<u64>,
    pub cursor: bool,
}

/// A captured RGB image and the physical rectangle it covers.
pub struct Captured {
    pub rect: Rect,
    pub rgb: Vec<u8>,
    pub cursor: Option<(i32, i32)>,
}

#[cfg(windows)]
pub mod win {
    use super::*;
    use crate::protocol::OpError;
    use serde_json::{Value, json};
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Graphics::Dwm::*;
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
    use windows_sys::Win32::System::Threading::*;
    use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = 2;

    pub struct Display {
        pub rect: Rect,
        pub primary: bool,
        pub dpi: u32,
        pub name: String,
    }

    fn wide_to_string(w: &[u16]) -> String {
        let end = w.iter().position(|&c| c == 0).unwrap_or(w.len());
        String::from_utf16_lossy(&w[..end])
    }

    unsafe extern "system" fn monitor_cb(
        mon: HMONITOR,
        _dc: HDC,
        _r: *mut RECT,
        data: LPARAM,
    ) -> windows_sys::core::BOOL {
        let list = unsafe { &mut *(data as *mut Vec<Display>) };
        let mut mi: MONITORINFOEXW = unsafe { zeroed() };
        mi.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        if unsafe { GetMonitorInfoW(mon, &mut mi as *mut _ as *mut MONITORINFO) } != 0 {
            let r = mi.monitorInfo.rcMonitor;
            let (mut dx, mut dy) = (96u32, 96u32);
            unsafe { GetDpiForMonitor(mon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) };
            list.push(Display {
                rect: Rect {
                    x: r.left,
                    y: r.top,
                    w: r.right - r.left,
                    h: r.bottom - r.top,
                },
                primary: mi.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
                dpi: dx,
                name: wide_to_string(&mi.szDevice),
            });
        }
        1
    }

    /// Monitors, primary first, then left-to-right / top-to-bottom.
    pub fn displays() -> Vec<Display> {
        let mut list: Vec<Display> = Vec::new();
        unsafe {
            EnumDisplayMonitors(
                std::ptr::null_mut(),
                std::ptr::null(),
                Some(monitor_cb),
                &mut list as *mut _ as LPARAM,
            );
        }
        list.sort_by_key(|d| (!d.primary, d.rect.x, d.rect.y));
        list
    }

    pub fn virtual_screen() -> Rect {
        unsafe {
            Rect {
                x: GetSystemMetrics(SM_XVIRTUALSCREEN),
                y: GetSystemMetrics(SM_YVIRTUALSCREEN),
                w: GetSystemMetrics(SM_CXVIRTUALSCREEN),
                h: GetSystemMetrics(SM_CYVIRTUALSCREEN),
            }
        }
    }

    pub fn displays_json() -> Value {
        let list: Vec<Value> = displays()
            .iter()
            .enumerate()
            .map(|(i, d)| {
                json!({
                    "index": i,
                    "name": d.name,
                    "primary": d.primary,
                    "x": d.rect.x, "y": d.rect.y, "width": d.rect.w, "height": d.rect.h,
                    "dpi": d.dpi,
                    "scale": d.dpi as f64 / 96.0,
                })
            })
            .collect();
        let v = virtual_screen();
        json!({"displays": list, "virtual": v.json()})
    }

    fn hwnd(h: u64) -> HWND {
        h as usize as HWND
    }

    /// Visible frame of a window (without the invisible resize borders).
    pub fn window_rect(h: HWND) -> Option<Rect> {
        let mut r: RECT = unsafe { zeroed() };
        let ok = unsafe {
            DwmGetWindowAttribute(
                h,
                DWMWA_EXTENDED_FRAME_BOUNDS as u32,
                &mut r as *mut _ as *mut _,
                size_of::<RECT>() as u32,
            )
        } == 0;
        if !ok && unsafe { GetWindowRect(h, &mut r) } == 0 {
            return None;
        }
        Some(Rect {
            x: r.left,
            y: r.top,
            w: r.right - r.left,
            h: r.bottom - r.top,
        })
    }

    fn cursor_pos() -> Option<(i32, i32)> {
        let mut p: POINT = unsafe { zeroed() };
        (unsafe { GetCursorPos(&mut p) } != 0).then_some((p.x, p.y))
    }

    /// Draw the current cursor onto `mem` whose top-left is at `origin`.
    unsafe fn draw_cursor(mem: HDC, origin: (i32, i32)) {
        let mut ci: CURSORINFO = unsafe { zeroed() };
        ci.cbSize = size_of::<CURSORINFO>() as u32;
        if unsafe { GetCursorInfo(&mut ci) } == 0 || ci.flags & CURSOR_SHOWING == 0 {
            return;
        }
        let mut ii: ICONINFO = unsafe { zeroed() };
        let (mut hx, mut hy) = (0, 0);
        if unsafe { GetIconInfo(ci.hCursor, &mut ii) } != 0 {
            hx = ii.xHotspot as i32;
            hy = ii.yHotspot as i32;
            if !ii.hbmMask.is_null() {
                unsafe { DeleteObject(ii.hbmMask as _) };
            }
            if !ii.hbmColor.is_null() {
                unsafe { DeleteObject(ii.hbmColor as _) };
            }
        }
        unsafe {
            DrawIconEx(
                mem,
                ci.ptScreenPos.x - hx - origin.0,
                ci.ptScreenPos.y - hy - origin.1,
                ci.hCursor,
                0,
                0,
                0,
                std::ptr::null_mut(),
                DI_NORMAL | DI_DEFAULTSIZE,
            )
        };
    }

    /// Read a `w`×`h` bitmap selected in `mem` as RGB.
    unsafe fn read_rgb(mem: HDC, bmp: HBITMAP, w: i32, h: i32) -> Option<Vec<u8>> {
        let mut bgra = vec![0u8; (w * h * 4) as usize];
        let mut bi: BITMAPINFO = unsafe { zeroed() };
        bi.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h;
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB;
        let lines = unsafe {
            GetDIBits(
                mem,
                bmp,
                0,
                h as u32,
                bgra.as_mut_ptr() as _,
                &mut bi,
                DIB_RGB_COLORS,
            )
        };
        if lines == 0 {
            return None;
        }
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        for px in bgra.as_chunks::<4>().0 {
            rgb.extend_from_slice(&[px[2], px[1], px[0]]);
        }
        Some(rgb)
    }

    /// BitBlt a rectangle of the desktop.
    fn capture_screen(r: Rect, cursor: bool) -> Result<Vec<u8>, OpError> {
        unsafe {
            let screen = GetDC(std::ptr::null_mut());
            if screen.is_null() {
                return Err(OpError::new("EIO", "GetDC failed"));
            }
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, r.w, r.h);
            let old = SelectObject(mem, bmp as _);
            let ok = BitBlt(mem, 0, 0, r.w, r.h, screen, r.x, r.y, SRCCOPY | CAPTUREBLT);
            if cursor {
                draw_cursor(mem, (r.x, r.y));
            }
            let rgb = if ok != 0 {
                read_rgb(mem, bmp, r.w, r.h)
            } else {
                None
            };
            SelectObject(mem, old);
            DeleteObject(bmp as _);
            DeleteDC(mem);
            ReleaseDC(std::ptr::null_mut(), screen);
            rgb.ok_or_else(|| {
                OpError::new(
                    "EIO",
                    "screen capture failed (desktop locked or not interactive?)",
                )
            })
        }
    }

    /// Render a window with PrintWindow (works when it is covered), cropped to its visible frame.
    fn capture_window(h: HWND, cursor: bool) -> Result<(Rect, Vec<u8>), OpError> {
        if unsafe { IsWindow(h) } == 0 {
            return Err(OpError::new("ENOENT", "no such window"));
        }
        if unsafe { IsIconic(h) } != 0 {
            return Err(OpError::invalid(
                "the window is minimized; restore it first",
            ));
        }
        let mut wr: RECT = unsafe { zeroed() };
        unsafe { GetWindowRect(h, &mut wr) };
        let full = Rect {
            x: wr.left,
            y: wr.top,
            w: wr.right - wr.left,
            h: wr.bottom - wr.top,
        };
        let frame = window_rect(h)
            .and_then(|f| f.intersect(&full))
            .unwrap_or(full);
        if full.w <= 0 || full.h <= 0 {
            return Err(OpError::new("EIO", "the window has no area"));
        }
        let rgb = unsafe {
            let screen = GetDC(std::ptr::null_mut());
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, full.w, full.h);
            let old = SelectObject(mem, bmp as _);
            let ok = PrintWindow(h, mem, PW_RENDERFULLCONTENT) != 0;
            if cursor {
                draw_cursor(mem, (full.x, full.y));
            }
            let rgb = if ok {
                read_rgb(mem, bmp, full.w, full.h)
            } else {
                None
            };
            SelectObject(mem, old);
            DeleteObject(bmp as _);
            DeleteDC(mem);
            ReleaseDC(std::ptr::null_mut(), screen);
            rgb
        };
        let Some(rgb) = rgb else {
            // Fall back to the visible pixels on screen.
            return Ok((frame, capture_screen(frame, cursor)?));
        };
        // Crop to the visible frame.
        let (ox, oy) = ((frame.x - full.x) as usize, (frame.y - full.y) as usize);
        let mut out = Vec::with_capacity((frame.w * frame.h * 3) as usize);
        for y in 0..frame.h as usize {
            let start = ((oy + y) * full.w as usize + ox) * 3;
            out.extend_from_slice(&rgb[start..start + frame.w as usize * 3]);
        }
        Ok((frame, out))
    }

    pub fn capture(spec: &CaptureSpec) -> Result<Captured, OpError> {
        let cursor = spec.cursor.then(cursor_pos).flatten();
        if let Some(h) = spec.window {
            let (rect, rgb) = capture_window(hwnd(h), spec.cursor)?;
            return Ok(Captured { rect, rgb, cursor });
        }
        let virt = virtual_screen();
        if virt.w <= 0 || virt.h <= 0 {
            return Err(OpError::new(
                "EIO",
                "no visible desktop (is this an interactive session?)",
            ));
        }
        let base = match spec.display {
            Some(i) if i < 0 => virt,
            Some(i) => {
                let list = displays();
                list.get(i as usize).map(|d| d.rect).ok_or_else(|| {
                    OpError::invalid(format!("no display {i} ({} attached)", list.len()))
                })?
            }
            None if spec.rect.is_some() => virt,
            None => displays().first().map(|d| d.rect).unwrap_or(virt),
        };
        let rect = match spec.rect {
            Some(r) => r
                .intersect(&virt)
                .ok_or_else(|| OpError::invalid("rect lies outside the desktop"))?,
            None => base,
        };
        let rgb = capture_screen(rect, spec.cursor)?;
        Ok(Captured { rect, rgb, cursor })
    }

    // ---- windows -------------------------------------------------------------

    fn text_of(h: HWND) -> String {
        let n = unsafe { GetWindowTextLengthW(h) };
        if n <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; n as usize + 1];
        let got = unsafe { GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..got.max(0) as usize])
    }

    fn class_of(h: HWND) -> String {
        let mut buf = [0u16; 256];
        let n = unsafe { GetClassNameW(h, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn process_name(pid: u32) -> String {
        unsafe {
            let p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if p.is_null() {
                return String::new();
            }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(p, 0, buf.as_mut_ptr(), &mut len);
            CloseHandle(p);
            if ok == 0 {
                return String::new();
            }
            let full = String::from_utf16_lossy(&buf[..len as usize]);
            full.rsplit('\\').next().unwrap_or("").to_string()
        }
    }

    fn cloaked(h: HWND) -> bool {
        let mut c: u32 = 0;
        unsafe {
            DwmGetWindowAttribute(
                h,
                DWMWA_CLOAKED as u32,
                &mut c as *mut _ as *mut _,
                size_of::<u32>() as u32,
            ) == 0
                && c != 0
        }
    }

    unsafe extern "system" fn enum_cb(h: HWND, data: LPARAM) -> windows_sys::core::BOOL {
        let list = unsafe { &mut *(data as *mut Vec<HWND>) };
        list.push(h);
        1
    }

    /// Top-level, visible, titled, uncloaked windows in z-order (topmost first).
    pub fn windows(all: bool) -> Value {
        let mut hs: Vec<HWND> = Vec::new();
        unsafe { EnumWindows(Some(enum_cb), &mut hs as *mut _ as LPARAM) };
        let fg = unsafe { GetForegroundWindow() };
        let mut out = Vec::new();
        for h in hs {
            let visible = unsafe { IsWindowVisible(h) } != 0;
            let title = text_of(h);
            let ex = unsafe { GetWindowLongW(h, GWL_EXSTYLE) } as u32;
            if !all
                && (!visible
                    || title.is_empty()
                    || cloaked(h)
                    || (ex & WS_EX_TOOLWINDOW != 0 && ex & WS_EX_APPWINDOW == 0))
            {
                continue;
            }
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(h, &mut pid) };
            let r = window_rect(h).unwrap_or(Rect {
                x: 0,
                y: 0,
                w: 0,
                h: 0,
            });
            out.push(json!({
                "hwnd": h as usize as u64,
                "title": title,
                "class": class_of(h),
                "pid": pid,
                "process": process_name(pid),
                "x": r.x, "y": r.y, "width": r.w, "height": r.h,
                "visible": visible,
                "minimized": unsafe { IsIconic(h) } != 0,
                "maximized": unsafe { IsZoomed(h) } != 0,
                "foreground": h == fg,
                "topmost": ex & WS_EX_TOPMOST != 0,
            }));
        }
        json!({ "windows": out, "foreground": fg as usize as u64 })
    }

    fn force_foreground(h: HWND) -> bool {
        unsafe {
            if IsIconic(h) != 0 {
                ShowWindow(h, SW_RESTORE);
            }
            if SetForegroundWindow(h) != 0 && GetForegroundWindow() == h {
                return true;
            }
            // Attach to the foreground thread's input queue so the switch is allowed.
            let fg = GetForegroundWindow();
            let fg_thread = GetWindowThreadProcessId(fg, std::ptr::null_mut());
            let me = GetCurrentThreadId();
            let attached =
                fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, 1) != 0;
            BringWindowToTop(h);
            SetForegroundWindow(h);
            if attached {
                AttachThreadInput(me, fg_thread, 0);
            }
            if GetForegroundWindow() == h {
                return true;
            }
            // Last resort: an injected (empty) input event makes us the "last input" process.
            let mut i: INPUT = zeroed();
            i.r#type = INPUT_MOUSE;
            i.Anonymous.mi.dwFlags = MOUSEEVENTF_MOVE;
            SendInput(1, &i, size_of::<INPUT>() as i32);
            SetForegroundWindow(h);
            GetForegroundWindow() == h
        }
    }

    pub fn window_action(h: u64, action: &str, rect: Option<Rect>) -> Result<Value, OpError> {
        let h = hwnd(h);
        if unsafe { IsWindow(h) } == 0 {
            return Err(OpError::new("ENOENT", "no such window"));
        }
        let ok = unsafe {
            match action {
                "focus" | "activate" => force_foreground(h),
                "minimize" => {
                    ShowWindow(h, SW_MINIMIZE);
                    true
                }
                "maximize" => {
                    ShowWindow(h, SW_MAXIMIZE);
                    true
                }
                "restore" => {
                    ShowWindow(h, SW_RESTORE);
                    true
                }
                "close" => PostMessageW(h, WM_CLOSE, 0, 0) != 0,
                "move" => {
                    let r =
                        rect.ok_or_else(|| OpError::invalid("move needs x, y, width, height"))?;
                    if IsZoomed(h) != 0 || IsIconic(h) != 0 {
                        ShowWindow(h, SW_RESTORE);
                    }
                    // Callers give the visible frame; compensate for invisible borders.
                    let mut wr: RECT = zeroed();
                    GetWindowRect(h, &mut wr);
                    let f = window_rect(h).unwrap_or(Rect {
                        x: wr.left,
                        y: wr.top,
                        w: wr.right - wr.left,
                        h: wr.bottom - wr.top,
                    });
                    let (l, t) = (f.x - wr.left, f.y - wr.top);
                    let (rr, b) = (wr.right - (f.x + f.w), wr.bottom - (f.y + f.h));
                    SetWindowPos(
                        h,
                        std::ptr::null_mut(),
                        r.x - l,
                        r.y - t,
                        r.w + l + rr,
                        r.h + t + b,
                        SWP_NOZORDER | SWP_NOACTIVATE,
                    ) != 0
                }
                other => return Err(OpError::invalid(format!("unknown window action `{other}`"))),
            }
        };
        let r = window_rect(h);
        Ok(json!({
            "ok": ok,
            "foreground": unsafe { GetForegroundWindow() } == h,
            "minimized": unsafe { IsIconic(h) } != 0,
            "rect": r.map(|r| r.json()),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_sizes() {
        assert_eq!(fit(2560, 1440, 1280, 1280), (1280, 720));
        assert_eq!(fit(1256, 2760, 1280, 1280), (582, 1280));
        assert_eq!(fit(800, 600, 1280, 1280), (800, 600));
        assert_eq!(fit(800, 600, 0, 0), (800, 600));
        assert_eq!(fit(3000, 10, 300, 0), (300, 1));
    }

    #[test]
    fn resize_averages() {
        // 4x2 → 2x1: each output pixel averages a 2x2 block.
        let mut src = Vec::new();
        for v in [0u8, 100, 200, 255, 50, 100, 0, 255] {
            src.extend_from_slice(&[v, v, v]);
        }
        let out = resize_rgb(&src, 4, 2, 2, 1);
        assert_eq!(out, vec![63, 63, 63, 178, 178, 178]);
        // Non-integer factor keeps a flat colour flat.
        let flat = vec![77u8; 7 * 5 * 3];
        assert!(resize_rgb(&flat, 7, 5, 3, 2).iter().all(|&v| v == 77));
        // Identity.
        assert_eq!(resize_rgb(&src, 4, 2, 4, 2), src);
    }

    #[test]
    fn rect_intersection() {
        let a = Rect {
            x: 0,
            y: 0,
            w: 100,
            h: 100,
        };
        let b = Rect {
            x: 50,
            y: -10,
            w: 100,
            h: 30,
        };
        assert_eq!(
            a.intersect(&b),
            Some(Rect {
                x: 50,
                y: 0,
                w: 50,
                h: 20
            })
        );
        assert_eq!(
            a.intersect(&Rect {
                x: 200,
                y: 0,
                w: 5,
                h: 5
            }),
            None
        );
    }
}
