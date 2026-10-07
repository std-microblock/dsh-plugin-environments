//! Small helpers (randomness, hex, PNG encoding, Windows code pages).

/// Fill `buf` with OS randomness.
pub fn random_bytes(buf: &mut [u8]) {
    getrandom::fill(buf).expect("OS random number generator unavailable");
}

pub fn random_u64() -> u64 {
    let mut b = [0u8; 8];
    random_bytes(&mut b);
    u64::from_le_bytes(b)
}

pub fn random_u32() -> u32 {
    let mut b = [0u8; 4];
    random_bytes(&mut b);
    u32::from_le_bytes(b)
}

pub fn hex(bytes: &[u8]) -> String {
    const D: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(D[(b >> 4) as usize] as char);
        s.push(D[(b & 15) as usize] as char);
    }
    s
}

/// Encode 8-bit RGB pixels (row-major, no padding) as a PNG.
#[cfg(windows)]
pub fn png_rgb(width: u32, height: u32, rgb: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgb.len() / 4 + 64);
    let mut enc = png::Encoder::new(&mut out, width, height);
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Eight);
    // Fast deflate with the Sub filter: cheap and compresses screenshots well.
    enc.set_compression(png::Compression::Fast);
    enc.set_filter(png::Filter::Sub);
    let written = enc
        .write_header()
        .and_then(|mut w| w.write_image_data(rgb).and_then(|()| w.finish()));
    if written.is_err() {
        out.clear();
    }
    out
}

/// Windows code-page text handling for process output.
#[cfg(windows)]
pub mod codepage {
    use windows_sys::Win32::Globalization::{
        GetOEMCP, IsDBCSLeadByteEx, MB_ERR_INVALID_CHARS, MultiByteToWideChar,
    };

    /// The OEM code page: what a new console starts with, so what console programs
    /// writing to a pipe use unless told otherwise (936 on Chinese Windows).
    pub fn oem() -> u32 {
        unsafe { GetOEMCP() }
    }

    fn to_wide(cp: u32, bytes: &[u8], flags: u32) -> Option<Vec<u16>> {
        if bytes.is_empty() {
            return Some(Vec::new());
        }
        let len = i32::try_from(bytes.len()).ok()?;
        unsafe {
            let n = MultiByteToWideChar(cp, flags, bytes.as_ptr(), len, std::ptr::null_mut(), 0);
            if n <= 0 {
                return None;
            }
            let mut w = vec![0u16; n as usize];
            let n = MultiByteToWideChar(cp, flags, bytes.as_ptr(), len, w.as_mut_ptr(), n);
            if n <= 0 {
                return None;
            }
            w.truncate(n as usize);
            Some(w)
        }
    }

    /// Decode code-page bytes (invalid sequences become U+FFFD).
    pub fn decode(cp: u32, bytes: &[u8]) -> String {
        match to_wide(cp, bytes, 0) {
            Some(w) => String::from_utf16_lossy(&w),
            None => String::from_utf8_lossy(bytes).into_owned(),
        }
    }

    /// Decode bytes that are either UTF-8 or text in the given code page.
    pub fn decode_any(cp: u32, bytes: &[u8]) -> String {
        match std::str::from_utf8(bytes) {
            Ok(s) => s.to_string(),
            Err(_) => decode(cp, bytes),
        }
    }

    /// Whether `bytes` are well-formed in the code page.
    pub fn valid(cp: u32, bytes: &[u8]) -> bool {
        to_wide(cp, bytes, MB_ERR_INVALID_CHARS).is_some()
    }

    /// Length of the prefix of `bytes` that does not end inside a double-byte character.
    fn complete_prefix(cp: u32, bytes: &[u8]) -> usize {
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] >= 0x80 && unsafe { IsDBCSLeadByteEx(cp, bytes[i]) } != 0 {
                if i + 1 == bytes.len() {
                    return i;
                }
                i += 2;
            } else {
                i += 1;
            }
        }
        bytes.len()
    }

    /// Incremental decoder turning a console program's output into UTF-8.
    ///
    /// Output is judged line by line: a line that is valid UTF-8 passes through
    /// unchanged, anything else is decoded with the code page (programs that ignore
    /// the console code page, or ran before it was switched, still come out right).
    /// Chunk boundaries inside a UTF-8 sequence or a double-byte character are held
    /// back until the next chunk. A UTF-8 byte order mark at the start is dropped.
    pub struct StreamDecoder {
        cp: u32,
        pending: Vec<u8>,
        started: bool,
    }

    impl StreamDecoder {
        pub fn new(cp: u32) -> StreamDecoder {
            StreamDecoder {
                cp,
                pending: Vec::new(),
                started: false,
            }
        }

        fn segment(&self, seg: &[u8], out: &mut Vec<u8>) {
            match std::str::from_utf8(seg) {
                Ok(_) => out.extend_from_slice(seg),
                Err(_) => out.extend_from_slice(decode(self.cp, seg).as_bytes()),
            }
        }

        /// Feed a chunk; returns the UTF-8 text that is complete so far.
        pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
            let mut buf = std::mem::take(&mut self.pending);
            buf.extend_from_slice(chunk);
            if !self.started {
                if buf.len() < 3 && b"\xEF\xBB\xBF".starts_with(&buf) {
                    self.pending = buf;
                    return Vec::new();
                }
                self.started = true;
                if buf.starts_with(b"\xEF\xBB\xBF") {
                    buf.drain(..3);
                }
            }
            let mut out = Vec::with_capacity(buf.len());
            let tail_start = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
            for seg in buf[..tail_start].split_inclusive(|&b| b == b'\n') {
                self.segment(seg, &mut out);
            }
            let tail = &buf[tail_start..];
            let keep = match std::str::from_utf8(tail) {
                Ok(_) => tail.len(),
                // Valid so far, cut inside a sequence.
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => complete_prefix(self.cp, tail),
            };
            self.segment(&tail[..keep], &mut out);
            self.pending = tail[keep..].to_vec();
            out
        }

        /// Flush whatever is held back at the end of the stream.
        pub fn finish(&mut self) -> Vec<u8> {
            let rest = std::mem::take(&mut self.pending);
            let mut out = Vec::new();
            self.segment(&rest, &mut out);
            out
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn codepage_decoder_handles_gbk_utf8_and_boundaries() {
        use codepage::StreamDecoder;
        // "中文" in GBK and UTF-8.
        let gbk = [0xD6u8, 0xD0, 0xCE, 0xC4];
        let utf8 = "中文".as_bytes();
        assert_eq!(codepage::decode(936, &gbk), "中文");
        assert!(codepage::valid(936, &gbk));
        assert!(!codepage::valid(936, &[0xD6]));
        assert_eq!(codepage::decode_any(936, utf8), "中文");
        assert_eq!(codepage::decode_any(936, &gbk), "中文");

        let run = |chunks: &[&[u8]]| {
            let mut d = StreamDecoder::new(936);
            let mut out = Vec::new();
            for c in chunks {
                out.extend(d.push(c));
            }
            out.extend(d.finish());
            String::from_utf8(out).unwrap()
        };
        // GBK split inside a character, mixed with a UTF-8 line.
        let mut mixed = b"a:".to_vec();
        mixed.extend_from_slice(&gbk);
        mixed.extend_from_slice(b"\r\nb:");
        mixed.extend_from_slice(utf8);
        mixed.push(b'\n');
        for split in 0..mixed.len() {
            let (x, y) = mixed.split_at(split);
            assert_eq!(run(&[x, y]), "a:中文\r\nb:中文\n", "split at {split}");
        }
        // Byte-by-byte UTF-8 with a BOM.
        let mut bom = b"\xEF\xBB\xBF".to_vec();
        bom.extend_from_slice("x中文".as_bytes());
        let bytes: Vec<&[u8]> = bom.chunks(1).collect();
        assert_eq!(run(&bytes), "x中文");
        // Partial output is emitted promptly (no newline needed).
        let mut d = StreamDecoder::new(936);
        assert_eq!(d.push(b"prompt> "), b"prompt> ");
        assert_eq!(d.push(&gbk[..3]), "中".as_bytes());
        assert_eq!(d.push(&gbk[3..]), "文".as_bytes());
        // A truncated stream is flushed rather than dropped.
        let mut d = StreamDecoder::new(936);
        assert!(d.push(&[0xE4, 0xB8]).is_empty());
        assert!(!d.finish().is_empty());
    }

    #[test]
    fn png_roundtrip() {
        let rgb: Vec<u8> = (0..4 * 3 * 3).map(|i| (i * 7) as u8).collect();
        let png = png_rgb(4, 3, &rgb);
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let mut r = png::Decoder::new(std::io::Cursor::new(png))
            .read_info()
            .unwrap();
        let mut buf = vec![0; r.output_buffer_size().unwrap()];
        let info = r.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (4, 3));
        assert_eq!(&buf[..info.buffer_size()], &rgb[..]);
    }
}
