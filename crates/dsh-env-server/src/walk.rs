//! Glob translation and a small gitignore-aware directory walker.
//!
//! This replaces the `globset` / `ignore` crates with the subset of behaviour the
//! server needs: globset-style globs (`literal_separator(true)`), hidden-file
//! filtering, and `.gitignore` / `.ignore` / `.git/info/exclude` / global gitignore
//! handling with the same precedence rules as ripgrep's `ignore` crate.

use regex_lite::Regex;
use std::fs;
use std::path::{Path, PathBuf};

fn push_literal(out: &mut String, c: char) {
    if "\\.+*?()|[]{}^$#&-~".contains(c) {
        out.push('\\');
    }
    out.push(c);
}

/// Translate a glob into an (unanchored) regex fragment.
///
/// Semantics follow globset with `literal_separator(true)`:
/// `?` and `*` never match `/`, `**` as a whole path component matches any number
/// of components, `[...]`/`[!...]` classes and `{a,b}` alternation are supported.
/// With `backslash_escape`, `\x` matches a literal `x` (gitignore style).
fn translate(
    chars: &[char],
    i: &mut usize,
    out: &mut String,
    backslash_escape: bool,
    in_alt: bool,
) -> Result<(), String> {
    while *i < chars.len() {
        let c = chars[*i];
        match c {
            '?' => {
                out.push_str("[^/]");
                *i += 1;
            }
            '*' => {
                if chars.get(*i + 1) == Some(&'*') {
                    let at_start = *i == 0 || chars[*i - 1] == '/';
                    let after = chars.get(*i + 2).copied();
                    if at_start && after == Some('/') {
                        // `**/` (at start or after `/`): zero or more leading components.
                        out.push_str("(?:[^/]*/)*");
                        *i += 3;
                        continue;
                    }
                    if at_start
                        && (after.is_none() || (in_alt && matches!(after, Some(',') | Some('}'))))
                    {
                        out.push_str(".*");
                        *i += 2;
                        continue;
                    }
                    // Not a component: behaves like `*`.
                    while chars.get(*i) == Some(&'*') {
                        *i += 1;
                    }
                    out.push_str("[^/]*");
                    continue;
                }
                out.push_str("[^/]*");
                *i += 1;
            }
            '[' => {
                let mut j = *i + 1;
                let mut class = String::from("[");
                if matches!(chars.get(j), Some('!') | Some('^')) {
                    class.push('^');
                    j += 1;
                }
                let first = j;
                let mut closed = false;
                while j < chars.len() {
                    let d = chars[j];
                    if d == ']' && j > first {
                        closed = true;
                        break;
                    }
                    match d {
                        '\\' | '[' | ']' | '&' | '~' | '^' => {
                            class.push('\\');
                            class.push(d);
                        }
                        _ => class.push(d),
                    }
                    j += 1;
                }
                if !closed {
                    return Err("unclosed character class; missing ']'".into());
                }
                class.push(']');
                out.push_str(&class);
                *i = j + 1;
            }
            '{' => {
                if in_alt {
                    return Err("nested alternate groups are not allowed".into());
                }
                *i += 1;
                out.push_str("(?:");
                loop {
                    translate(chars, i, out, backslash_escape, true)?;
                    match chars.get(*i) {
                        Some(',') => {
                            out.push('|');
                            *i += 1;
                        }
                        Some('}') => {
                            out.push(')');
                            *i += 1;
                            break;
                        }
                        _ => return Err("unclosed alternate group; missing '}'".into()),
                    }
                }
            }
            ',' | '}' if in_alt => return Ok(()),
            '\\' if backslash_escape => {
                match chars.get(*i + 1) {
                    Some(&n) => push_literal(out, n),
                    None => return Err("dangling '\\'".into()),
                }
                *i += 2;
            }
            _ => {
                push_literal(out, c);
                *i += 1;
            }
        }
    }
    Ok(())
}

fn glob_regex(pattern: &str, backslash_escape: bool) -> Result<Regex, String> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::from("^");
    let mut i = 0;
    translate(&chars, &mut i, &mut out, backslash_escape, false)?;
    out.push('$');
    Regex::new(&out).map_err(|e| e.to_string())
}

/// A compiled glob matched against `/`-separated relative paths.
pub struct Glob(Regex);

impl Glob {
    /// Compile a user glob the way the server always has: `\` is a separator,
    /// a leading `./` is dropped and slash-less patterns match at any depth.
    pub fn new(pattern: &str) -> Result<Glob, String> {
        let pattern = pattern.replace('\\', "/");
        let pattern = pattern.trim_start_matches("./");
        let pattern = if pattern.contains('/') {
            pattern.to_string()
        } else {
            format!("**/{pattern}")
        };
        glob_regex(&pattern, false).map(Glob)
    }
    pub fn is_match(&self, rel: &str) -> bool {
        self.0.is_match(rel)
    }
}

// ------------------------------------------------------------------ gitignore

struct Rule {
    re: Regex,
    negate: bool,
    dir_only: bool,
}

/// Rules from one ignore file, relative to `base`.
pub struct Rules {
    base: PathBuf,
    rules: Vec<Rule>,
}

impl Rules {
    pub fn parse(base: &Path, text: &str) -> Rules {
        let mut rules = Vec::new();
        for line in text.lines() {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            // Trailing spaces are ignored unless escaped.
            let mut line = line.to_string();
            while line.ends_with(' ') && !line.ends_with("\\ ") {
                line.pop();
            }
            let mut pat = line.as_str();
            let mut negate = false;
            if let Some(p) = pat.strip_prefix('!') {
                negate = true;
                pat = p;
            } else if pat.starts_with("\\!") || pat.starts_with("\\#") {
                pat = &pat[1..];
            }
            let mut dir_only = false;
            if pat.len() > 1 && pat.ends_with('/') {
                dir_only = true;
                pat = &pat[..pat.len() - 1];
            }
            if pat.is_empty() || pat == "/" {
                continue;
            }
            let anchored = pat.contains('/');
            let pat = pat.strip_prefix('/').unwrap_or(pat);
            let full = if anchored || pat.starts_with("**/") {
                pat.to_string()
            } else {
                format!("**/{pat}")
            };
            if let Ok(re) = glob_regex(&full, true) {
                rules.push(Rule {
                    re,
                    negate,
                    dir_only,
                });
            }
        }
        Rules {
            base: base.to_path_buf(),
            rules,
        }
    }

    pub fn load(dir: &Path, name: &str) -> Option<Rules> {
        let text = fs::read_to_string(dir.join(name)).ok()?;
        let r = Rules::parse(dir, &text);
        if r.rules.is_empty() { None } else { Some(r) }
    }

    fn load_file(base: &Path, file: &Path) -> Option<Rules> {
        let text = fs::read_to_string(file).ok()?;
        let r = Rules::parse(base, &text);
        if r.rules.is_empty() { None } else { Some(r) }
    }

    /// `Some(true)` = ignored, `Some(false)` = whitelisted, `None` = no rule matched.
    pub fn matched(&self, path: &Path, is_dir: bool) -> Option<bool> {
        let rel = path.strip_prefix(&self.base).ok()?;
        let rel = rel.to_string_lossy();
        let rel = if cfg!(windows) {
            rel.replace('\\', "/")
        } else {
            rel.into_owned()
        };
        if rel.is_empty() {
            return None;
        }
        for r in self.rules.iter().rev() {
            if r.dir_only && !is_dir {
                continue;
            }
            if r.re.is_match(&rel) {
                return Some(!r.negate);
            }
        }
        None
    }
}

struct Level {
    ignore: Option<Rules>,
    gitignore: Option<Rules>,
    exclude: Option<Rules>,
    repo_root: bool,
}

impl Level {
    fn load(dir: &Path, gitignore: bool) -> Level {
        if !gitignore {
            return Level {
                ignore: None,
                gitignore: None,
                exclude: None,
                repo_root: false,
            };
        }
        let repo_root = dir.join(".git").exists();
        let exclude = if repo_root {
            Rules::load_file(dir, &dir.join(".git").join("info").join("exclude"))
        } else {
            None
        };
        Level {
            ignore: Rules::load(dir, ".ignore"),
            gitignore: Rules::load(dir, ".gitignore"),
            exclude,
            repo_root,
        }
    }
}

fn global_gitignore() -> Option<Rules> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let mut path = None;
    if let Some(h) = &home
        && let Ok(cfg) = fs::read_to_string(h.join(".gitconfig"))
    {
        for line in cfg.lines() {
            let l = line.trim();
            if let Some((k, v)) = l.split_once('=')
                && k.trim().eq_ignore_ascii_case("excludesfile")
            {
                let v = v.trim().trim_matches('"');
                path = Some(match v.strip_prefix("~/") {
                    Some(rest) => h.join(rest),
                    None => PathBuf::from(v),
                });
            }
        }
    }
    let path = path.or_else(|| {
        let xdg = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| home.map(|h| h.join(".config")))?;
        Some(xdg.join("git").join("ignore"))
    })?;
    let text = fs::read_to_string(path).ok()?;
    // Global patterns are relative to the directory being searched; use an empty
    // base and match against the path relative to each repo/search root instead.
    let r = Rules::parse(Path::new(""), &text);
    if r.rules.is_empty() { None } else { Some(r) }
}

/// One directory entry produced by [`walk`].
pub struct Entry {
    pub path: PathBuf,
    pub depth: usize,
    pub file_type: fs::FileType,
}

impl Entry {
    pub fn metadata(&self) -> std::io::Result<fs::Metadata> {
        fs::symlink_metadata(&self.path)
    }
}

pub struct WalkOptions {
    /// Include hidden files and directories.
    pub hidden: bool,
    /// Respect .gitignore / .ignore / git exclude / global gitignore.
    pub gitignore: bool,
}

fn is_hidden(name: &str, _path: &Path) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 2;
        if let Ok(m) = fs::symlink_metadata(_path) {
            return m.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0;
        }
    }
    false
}

struct Walker<'a, F: FnMut(&Entry) -> bool> {
    opts: &'a WalkOptions,
    levels: Vec<Level>,
    global: Option<Rules>,
    root: PathBuf,
    f: F,
}

impl<F: FnMut(&Entry) -> bool> Walker<'_, F> {
    fn ignored(&self, path: &Path, is_dir: bool) -> bool {
        if !self.opts.gitignore {
            return false;
        }
        // .ignore beats .gitignore; deeper files beat shallower ones.
        for lv in self.levels.iter().rev() {
            if let Some(m) = lv.ignore.as_ref().and_then(|r| r.matched(path, is_dir)) {
                return m;
            }
        }
        for lv in self.levels.iter().rev() {
            if let Some(m) = lv.gitignore.as_ref().and_then(|r| r.matched(path, is_dir)) {
                return m;
            }
            if lv.repo_root {
                break;
            }
        }
        if let Some(lv) = self.levels.iter().rev().find(|l| l.repo_root)
            && let Some(m) = lv.exclude.as_ref().and_then(|r| r.matched(path, is_dir))
        {
            return m;
        }
        if let Some(g) = &self.global
            && let Ok(rel) = path.strip_prefix(&self.root)
            && let Some(m) = g.matched(rel, is_dir)
        {
            return m;
        }
        false
    }

    /// Returns false when the callback asked to stop.
    fn dir(&mut self, dir: &Path, depth: usize) -> bool {
        let Ok(rd) = fs::read_dir(dir) else {
            return true;
        };
        let mut entries: Vec<(String, PathBuf, fs::FileType)> = rd
            .filter_map(Result::ok)
            .filter_map(|e| {
                let ft = e.file_type().ok()?;
                Some((e.file_name().to_string_lossy().into_owned(), e.path(), ft))
            })
            .collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        for (name, path, ft) in entries {
            if !self.opts.hidden && is_hidden(&name, &path) {
                continue;
            }
            let is_dir = ft.is_dir();
            if self.ignored(&path, is_dir) {
                continue;
            }
            let entry = Entry {
                path,
                depth,
                file_type: ft,
            };
            if !(self.f)(&entry) {
                return false;
            }
            if is_dir {
                self.levels
                    .push(Level::load(&entry.path, self.opts.gitignore));
                let go_on = self.dir(&entry.path, depth + 1);
                self.levels.pop();
                if !go_on {
                    return false;
                }
            }
        }
        true
    }
}

/// Walk `root` depth-first (entries sorted by name, symlinks not followed),
/// calling `f` for every entry including the root itself (depth 0).
/// `f` returns false to stop the walk.
pub fn walk<F: FnMut(&Entry) -> bool>(root: &Path, opts: &WalkOptions, mut f: F) {
    let Ok(meta) = fs::symlink_metadata(root) else {
        return;
    };
    let ft = meta.file_type();
    if !f(&Entry {
        path: root.to_path_buf(),
        depth: 0,
        file_type: ft,
    }) || !ft.is_dir()
    {
        return;
    }
    let mut levels = Vec::new();
    if opts.gitignore {
        // Ignore files from parent directories apply as well (ignore's `parents(true)`).
        let mut ancestors: Vec<&Path> = root.ancestors().skip(1).collect();
        ancestors.reverse();
        for a in ancestors {
            levels.push(Level::load(a, true));
        }
        levels.push(Level::load(root, true));
    }
    let global = if opts.gitignore {
        global_gitignore()
    } else {
        None
    };
    let mut w = Walker {
        opts,
        levels,
        global,
        root: root.to_path_buf(),
        f,
    };
    w.dir(root, 1);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(p: &str, s: &str) -> bool {
        Glob::new(p).unwrap().is_match(s)
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
        assert!(Glob::new("[abc").is_err());
        assert!(Glob::new("{a,b").is_err());
    }

    #[test]
    fn gitignore_rules() {
        let base = Path::new("/r");
        let r = Rules::parse(
            base,
            "# c\n*.log\n!keep.log\nbuild/\n/top.txt\ndoc/*.md\n\\#hash\n",
        );
        let m = |p: &str, d: bool| r.matched(&Path::new("/r").join(p), d);
        assert_eq!(m("a.log", false), Some(true));
        assert_eq!(m("x/a.log", false), Some(true));
        assert_eq!(m("keep.log", false), Some(false));
        assert_eq!(m("build", true), Some(true));
        assert_eq!(m("build", false), None);
        assert_eq!(m("x/build", true), Some(true));
        assert_eq!(m("top.txt", false), Some(true));
        assert_eq!(m("x/top.txt", false), None);
        assert_eq!(m("doc/a.md", false), Some(true));
        assert_eq!(m("x/doc/a.md", false), None);
        assert_eq!(m("#hash", false), Some(true));
        assert_eq!(m("main.rs", false), None);
    }

    #[test]
    fn walk_respects_ignores() {
        let dir = std::env::temp_dir().join(format!("dsh-walk-{}", crate::util::random_u64()));
        let mk = |p: &str, s: &str| {
            let f = dir.join(p);
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(f, s).unwrap();
        };
        mk(".gitignore", "target/\n*.tmp\n");
        mk("src/a.rs", "x");
        mk("src/b.tmp", "x");
        mk("src/.ignore", "!b.tmp\nc.rs\n");
        mk("src/c.rs", "x");
        mk("target/out", "x");
        mk(".hidden/h", "x");
        let collect = |hidden, gitignore| {
            let mut v = Vec::new();
            walk(&dir, &WalkOptions { hidden, gitignore }, |e| {
                if e.depth > 0 {
                    v.push(
                        e.path
                            .strip_prefix(&dir)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
                true
            });
            v
        };
        assert_eq!(collect(false, true), vec!["src", "src/a.rs", "src/b.tmp"]);
        let all = collect(true, false);
        assert!(all.contains(&"target/out".to_string()) && all.contains(&".hidden/h".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }
}
