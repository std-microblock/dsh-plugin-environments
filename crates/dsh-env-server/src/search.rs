//! `fs.glob` and `fs.grep` over a directory tree, built on ripgrep's libraries:
//! `ignore` (gitignore-aware parallel-capable walker), `globset`, `grep-regex` and
//! `grep-searcher`. Result shapes and limits: docs/protocol.md.

use crate::fs_ops::clean_path;
use crate::protocol::{Args, OpError, OpResult};
use crate::session::{Session, ok};
use globset::{GlobBuilder, GlobMatcher};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::Lossy;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder};
use ignore::WalkBuilder;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

/// Upper bound on glob candidates collected before sorting.
const MAX_COLLECT: usize = 200_000;
/// Characters of a matched line kept in `fs.grep` results.
const MAX_TEXT: usize = 500;

/// Compile a user glob: `\` counts as a separator, a leading `./` is dropped and
/// slash-less patterns match at any depth; `*` / `?` never cross `/`.
fn compile_glob(pattern: &str) -> Result<GlobMatcher, OpError> {
    let pattern = pattern.replace('\\', "/");
    let pattern = pattern.trim_start_matches("./");
    let pattern = if pattern.contains('/') {
        pattern.to_string()
    } else {
        format!("**/{pattern}")
    };
    GlobBuilder::new(&pattern)
        .literal_separator(true)
        .backslash_escape(false)
        .build()
        .map(|g| g.compile_matcher())
        .map_err(|e| OpError::invalid(format!("invalid glob: {e}")))
}

fn rel_slash(base: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(base).unwrap_or(path);
    let s = rel.to_string_lossy().replace('\\', "/");
    s.trim_start_matches('/').to_string()
}

/// Depth-first walk sorted by name, symlinks not followed. `hidden` includes dot files
/// (and, on Windows, files with the hidden attribute); `gitignore` applies
/// `.gitignore` / `.ignore` / `.git/info/exclude` / the global gitignore, including
/// ignore files of parent directories, with or without a git repository.
fn walker(root: &Path, hidden: bool, gitignore: bool) -> WalkBuilder {
    let mut b = WalkBuilder::new(root);
    b.hidden(!hidden)
        .git_ignore(gitignore)
        .git_global(gitignore)
        .git_exclude(gitignore)
        .ignore(gitignore)
        .parents(gitignore)
        .require_git(false)
        .follow_links(false)
        .sort_by_file_name(|a, b| a.cmp(b));
    b
}

fn base_dir(s: &Session, a: &Args<'_>) -> PathBuf {
    let cwd = a.opt_str("cwd").unwrap_or("");
    let p = s.resolve(if cwd.is_empty() { "." } else { cwd }, None);
    std::fs::canonicalize(&p).map(clean_path).unwrap_or(p)
}

pub async fn glob(s: &Arc<Session>, args: Value) -> OpResult {
    let s = s.clone();
    tokio::task::spawn_blocking(move || glob_blocking(&s, Args(&args)))
        .await
        .map_err(|e| OpError::new("EIO", e.to_string()))?
}

fn glob_blocking(s: &Session, a: Args<'_>) -> OpResult {
    let pattern = a.str("pattern")?;
    let limit = a.opt_u64("limit").unwrap_or(1000).max(1) as usize;
    let base = base_dir(s, &a);
    if !base.is_dir() {
        return Err(OpError::new(
            "ENOTDIR",
            format!("not a directory: {}", base.display()),
        ));
    }
    let matcher = compile_glob(pattern)?;
    let mut found: Vec<(SystemTime, String)> = Vec::new();
    let mut truncated = false;
    let walk = walker(&base, a.bool("hidden", false), a.bool("gitignore", true)).build();
    for entry in walk.flatten() {
        if entry.depth() == 0 {
            continue;
        }
        let rel = rel_slash(&base, entry.path());
        if !matcher.is_match(&rel) {
            continue;
        }
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        found.push((mtime, rel));
        if found.len() >= MAX_COLLECT {
            truncated = true;
            break;
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    if found.len() > limit {
        truncated = true;
        found.truncate(limit);
    }
    let paths: Vec<String> = found.into_iter().map(|(_, p)| p).collect();
    ok(json!({ "paths": paths, "truncated": truncated, "cwd": base.to_string_lossy() }))
}

/// Trim the line terminator and cut to [`MAX_TEXT`] characters (with an ellipsis).
fn clip(text: &str) -> String {
    let t = text.trim_end_matches(['\r', '\n']);
    match t.char_indices().nth(MAX_TEXT) {
        Some((i, _)) => format!("{}\u{2026}", &t[..i]),
        None => t.to_string(),
    }
}

struct GrepOptions {
    multiline: bool,
}

fn build_matcher(
    pattern: &str,
    literal: bool,
    ignore_case: bool,
    multiline: bool,
) -> Result<RegexMatcher, OpError> {
    let mut b = RegexMatcherBuilder::new();
    b.fixed_strings(literal)
        .case_insensitive(ignore_case)
        .multi_line(true)
        .dot_matches_new_line(multiline);
    if !multiline {
        // Line-oriented search: lets grep-searcher scan whole buffers for candidate
        // lines instead of running the regex line by line.
        b.line_terminator(Some(b'\n'));
    }
    b.build(pattern)
        .map_err(|e| OpError::invalid(format!("invalid regex: {e}")))
}

/// UTF-8/UTF-16 BOMs are sniffed (UTF-16 is transcoded, the UTF-8 BOM dropped), other
/// bytes are read as lossy UTF-8. As in ripgrep, a NUL byte marks the file as binary:
/// the search stops there (a NUL in the first block means no results for the file).
fn build_searcher(o: &GrepOptions) -> Searcher {
    SearcherBuilder::new()
        .line_number(true)
        .multi_line(o.multiline)
        .binary_detection(BinaryDetection::quit(0))
        .build()
}

/// Search one file; `emit(line_number, text)` returns false to stop.
fn search_file(
    searcher: &mut Searcher,
    matcher: &RegexMatcher,
    path: &Path,
    emit: &mut dyn FnMut(u64, &str) -> bool,
) -> std::io::Result<()> {
    searcher.search_path(matcher, path, Lossy(|line, text| Ok(emit(line, text))))
}

pub async fn grep(s: &Arc<Session>, args: Value) -> OpResult {
    let s = s.clone();
    tokio::task::spawn_blocking(move || grep_blocking(&s, Args(&args)))
        .await
        .map_err(|e| OpError::new("EIO", e.to_string()))?
}

fn grep_blocking(s: &Session, a: Args<'_>) -> OpResult {
    let pattern = a.str("pattern")?;
    let limit = a.opt_u64("limit").unwrap_or(500).max(1) as usize;
    let files_only = a.bool("filesOnly", false);
    let opts = GrepOptions {
        multiline: a.bool("multiline", false),
    };
    let base = base_dir(s, &a);
    let root = match a.opt_str("path") {
        Some(p) if !p.is_empty() => {
            let r = PathBuf::from(p);
            if r.is_absolute() { r } else { base.join(r) }
        }
        _ => base.clone(),
    };
    if !root.exists() {
        return Err(OpError::new(
            "ENOENT",
            format!("path not found: {}", root.display()),
        ));
    }
    let glob = match a.opt_str("glob") {
        Some(g) if !g.is_empty() => Some(compile_glob(g)?),
        _ => None,
    };
    let matcher = build_matcher(
        pattern,
        a.bool("literal", false),
        a.bool("ignoreCase", false),
        opts.multiline,
    )?;
    let mut searcher = build_searcher(&opts);

    let mut matches: Vec<Value> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    let mut truncated = false;
    let walk = walker(&root, a.bool("hidden", false), a.bool("gitignore", true)).build();
    for entry in walk.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let rel = rel_slash(&base, entry.path());
        if glob.as_ref().is_some_and(|g| !g.is_match(&rel)) {
            continue;
        }
        let mut file_hit = false;
        let mut stop = false;
        let result = search_file(&mut searcher, &matcher, entry.path(), &mut |line, text| {
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
            continue;
        }
        if file_hit {
            files.push(rel.clone());
            if files_only && files.len() >= limit {
                truncated = true;
                break;
            }
        }
        if stop {
            truncated = true;
            break;
        }
    }
    ok(
        json!({ "matches": matches, "files": files, "truncated": truncated, "cwd": base.to_string_lossy() }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> TempDir {
            let d = std::env::temp_dir().join(format!("dsh-{tag}-{}", crate::util::random_u64()));
            fs::create_dir_all(&d).unwrap();
            TempDir(d)
        }
        fn file(&self, rel: &str, content: impl AsRef<[u8]>) -> PathBuf {
            let f = self.0.join(rel);
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(&f, content).unwrap();
            f
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn hits(pat: &str, path: &Path, literal: bool, ic: bool, ml: bool) -> Vec<(u64, String)> {
        let m = build_matcher(pat, literal, ic, ml).unwrap();
        let mut s = build_searcher(&GrepOptions { multiline: ml });
        let mut out = Vec::new();
        search_file(&mut s, &m, path, &mut |l, t| {
            out.push((l, t.to_string()));
            true
        })
        .unwrap();
        out
    }

    fn g(p: &str, s: &str) -> bool {
        compile_glob(p).unwrap().is_match(s)
    }

    #[test]
    fn globs() {
        assert!(g("*.rs", "main.rs"));
        assert!(g("*.rs", "src/main.rs"));
        assert!(!g("*.rs", "src/main.rsx"));
        assert!(g("src/*.rs", "src/main.rs"));
        assert!(!g("src/*.rs", "src/a/main.rs"));
        assert!(g("src/**/*.rs", "src/main.rs"));
        assert!(g("src/**/*.rs", "src/a/b/main.rs"));
        assert!(g("src/**", "src/a/b"));
        assert!(g("**", "a/b/c"));
        assert!(g("*.{js,ts}", "x/y.ts"));
        assert!(!g("*.{js,ts}", "x/y.rs"));
        assert!(g("file?.txt", "file1.txt"));
        assert!(!g("file?.txt", "file12.txt"));
        assert!(g("[ab]*.c", "a1.c"));
        assert!(!g("[!ab]*.c", "a1.c"));
        assert!(g("./src/*.rs", "src/x.rs"));
        assert!(g("src\\*.rs", "src/x.rs"));
        assert!(g("a+b(1).txt", "a+b(1).txt"));
        assert!(compile_glob("[abc").is_err());
        assert!(compile_glob("{a,b").is_err());
    }

    #[test]
    fn multiline_reports_spanned_lines() {
        let d = TempDir::new("grep-ml");
        let f = d.file("a.txt", "a\nb\nc\nd\ne\n");
        assert_eq!(
            hits("b.*?d", &f, false, false, true),
            vec![(2, "b\nc\nd\n".to_string())]
        );
        let f = d.file("b.txt", "x x\ny\nx\n");
        assert_eq!(
            hits("x", &f, false, false, true),
            vec![(1, "x x\n".to_string()), (3, "x\n".to_string())]
        );
        let f = d.file("c.txt", "a\nc\nd");
        assert_eq!(
            hits("c\\n", &f, false, false, true),
            vec![(2, "c\n".to_string())]
        );
    }

    #[test]
    fn literal_and_case_folding() {
        let d = TempDir::new("grep-lit");
        let text = "a.b*c(d)[e]{f}|g^h$i#j&k-l~m\\n\nplain\n";
        let f = d.file("a.txt", text);
        let pat = "a.b*c(d)[e]{f}|g^h$i#j&k-l~m\\n";
        assert_eq!(hits(pat, &f, true, false, false).len(), 1);
        // Unicode-aware case folding.
        let f = d.file("u.txt", "ПРИВЕТ мир\nstraße\n");
        assert_eq!(hits("привет", &f, false, true, false)[0].0, 1);
        assert!(hits("привет", &f, false, false, false).is_empty());
        assert_eq!(hits("STRASSE|STRAẞE", &f, false, true, false)[0].0, 2);
        assert!(build_matcher("(", false, false, false).is_err());
    }

    #[test]
    fn file_search_lines_bom_and_binary() {
        let d = TempDir::new("grep-bin");
        let p = d.file("f.txt", b"\xEF\xBB\xBFhello\r\nworld\nhello again\n");
        let got: Vec<(u64, String)> = hits("hello", &p, false, false, false)
            .into_iter()
            .map(|(l, t)| (l, clip(&t)))
            .collect();
        assert_eq!(
            got,
            vec![(1, "hello".to_string()), (3, "hello again".to_string())]
        );
        // Like ripgrep: a NUL byte marks the file as binary and it is not searched.
        let bin = d.file("b.bin", b"hello\n\0hello binary\n");
        assert!(hits("hello", &bin, false, false, false).is_empty());
        let mut b = vec![0xFF, 0xFE];
        for u in "x\nneedle\n".encode_utf16() {
            b.extend_from_slice(&u.to_le_bytes());
        }
        let p16 = d.file("u16.txt", b);
        let got: Vec<u64> = hits("needle", &p16, false, false, false)
            .into_iter()
            .map(|h| h.0)
            .collect();
        assert_eq!(got, vec![2]);
    }

    #[test]
    fn clip_limits_characters() {
        let long = "é".repeat(600);
        let c = clip(&format!("{long}\r\n"));
        assert_eq!(c.chars().count(), MAX_TEXT + 1);
        assert!(c.ends_with('\u{2026}'));
        assert_eq!(clip("short\n"), "short");
    }

    #[test]
    fn walk_respects_ignores() {
        let d = TempDir::new("walk");
        d.file(".gitignore", "target/\n*.tmp\n");
        d.file("src/a.rs", "x");
        d.file("src/b.tmp", "x");
        d.file("src/.ignore", "!b.tmp\nc.rs\n");
        d.file("src/c.rs", "x");
        d.file("target/out", "x");
        d.file(".hidden/h", "x");
        let collect = |hidden, gitignore| {
            walker(&d.0, hidden, gitignore)
                .build()
                .flatten()
                .filter(|e| e.depth() > 0)
                .map(|e| rel_slash(&d.0, e.path()))
                .collect::<Vec<_>>()
        };
        assert_eq!(collect(false, true), vec!["src", "src/a.rs", "src/b.tmp"]);
        let all = collect(true, false);
        assert!(all.contains(&"target/out".to_string()) && all.contains(&".hidden/h".to_string()));
    }
}
