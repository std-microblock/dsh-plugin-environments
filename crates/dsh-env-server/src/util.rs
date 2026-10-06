//! Small self-contained helpers (randomness, hex/base64, PNG encoding, Windows code pages).

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

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding.
pub fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = match chunk.len() {
            3 => (chunk[0] as u32) << 16 | (chunk[1] as u32) << 8 | chunk[2] as u32,
            2 => (chunk[0] as u32) << 16 | (chunk[1] as u32) << 8,
            _ => (chunk[0] as u32) << 16,
        };
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Standard base64 decoding (padding optional, whitespace rejected).
pub fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for (i, c) in s.bytes().enumerate() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err(format!("invalid base64 byte at offset {i}")),
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    if bits >= 6 {
        return Err("invalid base64 length".into());
    }
    Ok(out)
}

fn crc32(chunks: &[&[u8]]) -> u32 {
    let mut table = [0u32; 256];
    for (i, t) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
        *t = c;
    }
    let mut crc = !0u32;
    for chunk in chunks {
        for &b in *chunk {
            crc = table[((crc ^ b as u32) & 0xff) as usize] ^ (crc >> 8);
        }
    }
    !crc
}

fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc32(&[kind, data]).to_be_bytes());
}

/// Encode 8-bit RGB pixels (row-major, no padding) as a PNG.
pub fn png_rgb(width: u32, height: u32, rgb: &[u8]) -> Vec<u8> {
    let stride = width as usize * 3;
    // Filter type 1 (Sub) per row: cheap and compresses screenshots well.
    let mut raw = Vec::with_capacity((stride + 1) * height as usize);
    for row in rgb.chunks_exact(stride) {
        raw.push(1);
        for i in 0..stride {
            let left = if i >= 3 { row[i - 3] } else { 0 };
            raw.push(row[i].wrapping_sub(left));
        }
    }
    let z = miniz_oxide::deflate::compress_to_vec_zlib(&raw, 1);
    let mut out = Vec::with_capacity(z.len() + 64);
    out.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    png_chunk(&mut out, b"IHDR", &ihdr);
    png_chunk(&mut out, b"IDAT", &z);
    png_chunk(&mut out, b"IEND", &[]);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
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
    fn base64_roundtrip() {
        for s in ["", "f", "fo", "foo", "foob", "fooba", "foobar"] {
            let e = base64_encode(s.as_bytes());
            assert_eq!(base64_decode(&e).unwrap(), s.as_bytes());
        }
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert!(base64_decode("Zm9v!").is_err());
    }

    #[test]
    fn crc_known() {
        assert_eq!(crc32(&[b"IEND"]), 0xAE42_6082);
    }

    #[test]
    fn png_decodes_with_miniz() {
        let rgb: Vec<u8> = (0..4 * 3 * 3).map(|i| (i * 7) as u8).collect();
        let png = png_rgb(4, 3, &rgb);
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        // IDAT payload starts after signature(8) + IHDR chunk(25) + len/type(8).
        let len = u32::from_be_bytes(png[33..37].try_into().unwrap()) as usize;
        let z = &png[41..41 + len];
        let raw = miniz_oxide::inflate::decompress_to_vec_zlib(z).unwrap();
        assert_eq!(raw.len(), 3 * (4 * 3 + 1));
        // Undo Sub filter on the first row.
        let mut row = raw[1..13].to_vec();
        for i in 3..12 {
            row[i] = row[i].wrapping_add(row[i - 3]);
        }
        assert_eq!(&row[..], &rgb[..12]);
    }
}
