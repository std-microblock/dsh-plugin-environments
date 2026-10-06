//! glob and grep over a directory tree.

use crate::fs_ops::clean_path;
use crate::protocol::{Args, OpError, OpResult};
use crate::session::{Session, ok};
use crate::walk::{Glob, WalkOptions, walk};
use regex_lite::{Regex, RegexBuilder};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

const MAX_COLLECT: usize = 200_000;

fn compile_glob(pattern: &str) -> Result<Glob, OpError> {
    Glob::new(pattern).map_err(|e| OpError::invalid(format!("invalid glob: {e}")))
}

fn rel_slash(base: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(base).unwrap_or(path);
    let s = rel.to_string_lossy().replace('\\', "/");
    s.trim_start_matches('/').to_string()
}

fn base_dir(s: &Session, a: &Args<'_>) -> PathBuf {
    let cwd = a.opt_str("cwd").unwrap_or("");
    let p = s.resolve(if cwd.is_empty() { "." } else { cwd }, None);
    std::fs::canonicalize(&p).map(clean_path).unwrap_or(p)
}

pub async fn glob(s: &Arc<Session>, args: Value) -> OpResult {
    let s = s.clone();
    tokio::task::spawn_blocking(move || {
        let a = Args(&args);
        let pattern = a.str("pattern")?.to_string();
        let limit = a.opt_u64("limit").unwrap_or(1000).max(1) as usize;
        let opts = WalkOptions {
            hidden: a.bool("hidden", false),
            gitignore: a.bool("gitignore", true),
        };
        let base = base_dir(&s, &a);
        if !base.is_dir() {
            return Err(OpError::new(
                "ENOTDIR",
                format!("not a directory: {}", base.display()),
            ));
        }
        let matcher = compile_glob(&pattern)?;
        let mut found: Vec<(SystemTime, String)> = Vec::new();
        let mut truncated = false;
        walk(&base, &opts, |entry| {
            if entry.depth == 0 {
                return true;
            }
            let rel = rel_slash(&base, &entry.path);
            if !matcher.is_match(&rel) {
                return true;
            }
            let mtime = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            found.push((mtime, rel));
            if found.len() >= MAX_COLLECT {
                truncated = true;
                return false;
            }
            true
        });
        found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        if found.len() > limit {
            truncated = true;
            found.truncate(limit);
        }
        let paths: Vec<String> = found.into_iter().map(|(_, p)| p).collect();
        ok(json!({ "paths": paths, "truncated": truncated, "cwd": base.to_string_lossy() }))
    })
    .await
    .map_err(|e| OpError::new("EIO", e.to_string()))?
}

fn escape_regex(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for c in s.chars() {
        if "\\.+*?()|[]{}^$#&-~".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn clip(text: &str) -> String {
    let t = text.trim_end_matches(['\r', '\n']);
    match t.char_indices().nth(500) {
        Some((i, _)) => format!("{}\u{2026}", &t[..i]),
        None => t.to_string(),
    }
}

/// Decode a whole file: UTF-16 with BOM is transcoded, UTF-8 BOM dropped,
/// everything else is read as lossy UTF-8. Content from the first NUL byte on is
/// treated as binary and not searched.
fn decode(bytes: &[u8]) -> String {
    let utf16 = |be: bool| {
        let units: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| {
                if be {
                    u16::from_be_bytes([c[0], c[1]])
                } else {
                    u16::from_le_bytes([c[0], c[1]])
                }
            })
            .collect();
        let s = String::from_utf16_lossy(&units);
        match s.find('\0') {
            Some(i) => s[..i].to_string(),
            None => s,
        }
    };
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return utf16(false);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return utf16(true);
    }
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
    let b = match b.iter().position(|&c| c == 0) {
        Some(i) => &b[..i],
        None => b,
    };
    String::from_utf8_lossy(b).into_owned()
}

/// Search one file; `emit(line_number, text)` returns false to stop.
fn search_file(
    re: &Regex,
    path: &Path,
    multiline: bool,
    emit: &mut dyn FnMut(u64, &str) -> bool,
) -> std::io::Result<()> {
    let mut file = std::fs::File::open(path)?;
    let mut head = [0u8; 3];
    let mut n = 0;
    while n < 3 {
        match file.read(&mut head[n..])? {
            0 => break,
            k => n += k,
        }
    }
    let head = &head[..n];
    let utf16 = head.starts_with(&[0xFF, 0xFE]) || head.starts_with(&[0xFE, 0xFF]);
    if multiline || utf16 {
        let mut bytes = head.to_vec();
        file.read_to_end(&mut bytes)?;
        let text = decode(&bytes);
        if multiline {
            search_text_multiline(re, &text, emit);
        } else {
            for (i, line) in text.split_inclusive('\n').enumerate() {
                let l = line.strip_suffix('\n').unwrap_or(line);
                if re.is_match(l) && !emit(i as u64 + 1, line) {
                    break;
                }
            }
        }
        return Ok(());
    }
    let head = if head == [0xEF, 0xBB, 0xBF] {
        &head[3..]
    } else {
        head
    };
    let mut reader = BufReader::with_capacity(64 * 1024, head.chain(file));
    let mut buf = Vec::new();
    let mut line_no = 0u64;
    loop {
        buf.clear();
        if reader.read_until(b'\n', &mut buf)? == 0 {
            break;
        }
        line_no += 1;
        // Binary detection (NUL byte): stop searching this file.
        if let Some(i) = buf.iter().position(|&c| c == 0) {
            buf.truncate(i);
            let line = String::from_utf8_lossy(&buf);
            if !line.is_empty() && re.is_match(&line) {
                emit(line_no, &line);
            }
            break;
        }
        let line = String::from_utf8_lossy(&buf);
        let l = line.strip_suffix('\n').unwrap_or(&line);
        if re.is_match(l) && !emit(line_no, &line) {
            break;
        }
    }
    Ok(())
}

/// Report every match with the full lines it spans; matches sharing lines are merged.
fn search_text_multiline(re: &Regex, text: &str, emit: &mut dyn FnMut(u64, &str) -> bool) {
    let mut line_no = 1u64; // line number at `counted`
    let mut counted = 0usize;
    let mut pending: Option<(u64, usize, usize)> = None; // (line, start, end) of merged region
    let line_start = |pos: usize| text[..pos].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let line_end = |pos: usize| {
        text[pos..]
            .find('\n')
            .map(|i| pos + i + 1)
            .unwrap_or(text.len())
    };
    for m in re.find_iter(text) {
        if m.start() == text.len() && !text.is_empty() && text.ends_with('\n') {
            break;
        }
        let start = line_start(m.start());
        // The match end is exclusive; a match ending right after '\n' stays on that line.
        let last = if m.end() > m.start() {
            m.end() - 1
        } else {
            m.start()
        };
        let end = if last >= text.len() {
            text.len()
        } else {
            line_end(last)
        };
        line_no += text[counted..start].matches('\n').count() as u64;
        counted = start;
        match &mut pending {
            Some((_, _, pend)) if start < *pend => *pend = (*pend).max(end),
            _ => {
                if let Some((l, s, e)) = pending.take()
                    && !emit(l, &text[s..e])
                {
                    return;
                }
                pending = Some((line_no, start, end));
            }
        }
    }
    if let Some((l, s, e)) = pending {
        emit(l, &text[s..e]);
    }
}

pub async fn grep(s: &Arc<Session>, args: Value) -> OpResult {
    let s = s.clone();
    tokio::task::spawn_blocking(move || {
        let a = Args(&args);
        let pattern = a.str("pattern")?.to_string();
        let limit = a.opt_u64("limit").unwrap_or(500).max(1) as usize;
        let literal = a.bool("literal", false);
        let ignore_case = a.bool("ignoreCase", false);
        let multiline = a.bool("multiline", false);
        let files_only = a.bool("filesOnly", false);
        let opts = WalkOptions { hidden: a.bool("hidden", false), gitignore: a.bool("gitignore", true) };
        let base = base_dir(&s, &a);
        let root = match a.opt_str("path") {
            Some(p) if !p.is_empty() => {
                let r = PathBuf::from(p);
                if r.is_absolute() { r } else { base.join(r) }
            }
            _ => base.clone(),
        };
        if !root.exists() {
            return Err(OpError::new("ENOENT", format!("path not found: {}", root.display())));
        }
        let glob = match a.opt_str("glob") {
            Some(g) if !g.is_empty() => Some(compile_glob(g)?),
            _ => None,
        };
        let pat = if literal { escape_regex(&pattern) } else { pattern.clone() };
        let re = RegexBuilder::new(&pat)
            .case_insensitive(ignore_case)
            .multi_line(true)
            .dot_matches_new_line(multiline)
            .build()
            .map_err(|e| OpError::invalid(format!("invalid regex: {e}")))?;

        let mut matches: Vec<Value> = Vec::new();
        let mut files: Vec<String> = Vec::new();
        let mut truncated = false;
        walk(&root, &opts, |entry| {
            if !entry.file_type.is_file() {
                return true;
            }
            let rel = rel_slash(&base, &entry.path);
            if let Some(g) = &glob
                && !g.is_match(&rel) {
                    return true;
                }
            let mut file_hit = false;
            let mut stop = false;
            let result = search_file(&re, &entry.path, multiline, &mut |line, text| {
                file_hit = true;
                if files_only {
                    return false;
                }
                if matches.len() >= limit {
                    stop = true;
                    return false;
                }
                matches.push(json!({ "path": rel, "line": line, "text": clip(text) }));
                true
            });
            if result.is_err() {
                return true;
            }
            if file_hit {
                files.push(rel.clone());
                if files_only && files.len() >= limit {
                    truncated = true;
                    return false;
                }
            }
            if stop {
                truncated = true;
                return false;
            }
            true
        });
        ok(json!({ "matches": matches, "files": files, "truncated": truncated, "cwd": base.to_string_lossy() }))
    })
    .await
    .map_err(|e| OpError::new("EIO", e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ml(pat: &str, text: &str) -> Vec<(u64, String)> {
        let re = RegexBuilder::new(pat)
            .multi_line(true)
            .dot_matches_new_line(true)
            .build()
            .unwrap();
        let mut out = Vec::new();
        search_text_multiline(&re, text, &mut |l, t| {
            out.push((l, t.to_string()));
            true
        });
        out
    }

    #[test]
    fn multiline_reports_spanned_lines() {
        assert_eq!(
            ml("b.*?d", "a\nb\nc\nd\ne\n"),
            vec![(2, "b\nc\nd\n".to_string())]
        );
        assert_eq!(
            ml("x", "x x\ny\nx\n"),
            vec![(1, "x x\n".to_string()), (3, "x\n".to_string())]
        );
        assert_eq!(ml("c\\n", "a\nc\nd"), vec![(2, "c\n".to_string())]);
    }

    #[test]
    fn literal_escape_compiles() {
        let p = escape_regex("a.b*c(d)[e]{f}|g^h$i#j&k-l~m\\n");
        let re = Regex::new(&p).unwrap();
        assert!(re.is_match("a.b*c(d)[e]{f}|g^h$i#j&k-l~m\\n"));
    }

    #[test]
    fn file_search_lines_and_binary() {
        let dir = std::env::temp_dir().join(format!("dsh-grep-{}", crate::util::random_u64()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("f.txt");
        std::fs::write(
            &p,
            b"\xEF\xBB\xBFhello\r\nworld\nhello again\n\0hello binary\n",
        )
        .unwrap();
        let re = Regex::new("hello").unwrap();
        let mut got = Vec::new();
        search_file(&re, &p, false, &mut |l, t| {
            got.push((l, clip(t)));
            true
        })
        .unwrap();
        assert_eq!(
            got,
            vec![(1, "hello".to_string()), (3, "hello again".to_string())]
        );
        let p16 = dir.join("u16.txt");
        let mut b = vec![0xFF, 0xFE];
        for u in "x\nneedle\n".encode_utf16() {
            b.extend_from_slice(&u.to_le_bytes());
        }
        std::fs::write(&p16, b).unwrap();
        let mut got = Vec::new();
        search_file(&Regex::new("needle").unwrap(), &p16, false, &mut |l, _| {
            got.push(l);
            true
        })
        .unwrap();
        assert_eq!(got, vec![2]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
