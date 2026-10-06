//! Small self-contained helpers (randomness, hex/base64, PNG encoding).

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

#[cfg(test)]
mod tests {
    use super::*;

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
