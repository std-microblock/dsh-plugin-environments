//! glob and grep over a directory tree (ripgrep libraries).

use crate::fs_ops::clean_path;
use crate::protocol::{Args, OpError, OpResult};
use crate::session::{Session, ok};
use globset::{GlobBuilder, GlobMatcher};
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::Lossy;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::WalkBuilder;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

const MAX_COLLECT: usize = 200_000;

fn compile_glob(pattern: &str) -> Result<GlobMatcher, OpError> {
    let pattern = pattern.replace('\\', "/");
    let pattern = pattern.trim_start_matches("./").to_string();
    let pattern = if pattern.contains('/') { pattern } else { format!("**/{pattern}") };
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

fn walker(root: &Path, hidden: bool, gitignore: bool) -> WalkBuilder {
    let mut b = WalkBuilder::new(root);
    b.hidden(!hidden)
        .git_ignore(gitignore)
        .git_global(gitignore)
        .git_exclude(gitignore)
        .ignore(gitignore)
        .parents(gitignore)
        .require_git(false)
        .follow_links(false);
    b
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
        let hidden = a.bool("hidden", false);
        let gitignore = a.bool("gitignore", true);
        let base = base_dir(&s, &a);
        if !base.is_dir() {
            return Err(OpError::new("ENOTDIR", format!("not a directory: {}", base.display())));
        }
        let matcher = compile_glob(&pattern)?;
        let mut found: Vec<(SystemTime, String)> = Vec::new();
        let mut truncated = false;
        for entry in walker(&base, hidden, gitignore).build() {
            let Ok(entry) = entry else { continue };
            if entry.depth() == 0 {
                continue;
            }
            let rel = rel_slash(&base, entry.path());
            if !matcher.is_match(&rel) {
                continue;
            }
            let mtime = entry.metadata().ok().and_then(|m| m.modified().ok()).unwrap_or(SystemTime::UNIX_EPOCH);
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
        let hidden = a.bool("hidden", false);
        let gitignore = a.bool("gitignore", true);
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
        let matcher = RegexMatcherBuilder::new()
            .case_insensitive(ignore_case)
            .multi_line(true)
            .dot_matches_new_line(multiline)
            .build(&pat)
            .map_err(|e| OpError::invalid(format!("invalid regex: {e}")))?;
        let mut searcher = SearcherBuilder::new()
            .line_number(true)
            .multi_line(multiline)
            .binary_detection(BinaryDetection::quit(0))
            .build();

        let mut matches: Vec<Value> = Vec::new();
        let mut files: Vec<String> = Vec::new();
        let mut truncated = false;
        'walk: for entry in walker(&root, hidden, gitignore).build() {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let rel = rel_slash(&base, entry.path());
            if let Some(g) = &glob {
                if !g.is_match(&rel) {
                    continue;
                }
            }
            let mut file_hit = false;
            let mut stop = false;
            let result = searcher.search_path(
                &matcher,
                entry.path(),
                Lossy(|line, text| {
                    file_hit = true;
                    if files_only {
                        return Ok(false);
                    }
                    if matches.len() >= limit {
                        stop = true;
                        return Ok(false);
                    }
                    let mut t = text.trim_end_matches(['\r', '\n']).to_string();
                    if t.chars().count() > 500 {
                        t = t.chars().take(500).collect::<String>() + "…";
                    }
                    matches.push(json!({ "path": rel, "line": line, "text": t }));
                    Ok(true)
                }),
            );
            if result.is_err() {
                continue;
            }
            if file_hit {
                files.push(rel.clone());
                if files_only && files.len() >= limit {
                    truncated = true;
                    break 'walk;
                }
            }
            if stop {
                truncated = true;
                break 'walk;
            }
        }
        ok(json!({ "matches": matches, "files": files, "truncated": truncated, "cwd": base.to_string_lossy() }))
    })
    .await
    .map_err(|e| OpError::new("EIO", e.to_string()))?
}
