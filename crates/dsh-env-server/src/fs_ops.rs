//! Filesystem operations.

use crate::protocol::{Args, OpError, OpResult};
use crate::session::{Inbound, Session, ok};
use serde_json::{Value, json};
use std::fs;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

const DEFAULT_MAX: u64 = 16 * 1024 * 1024;

fn file_type(meta: &fs::Metadata) -> &'static str {
    let ft = meta.file_type();
    if ft.is_symlink() {
        "symlink"
    } else if ft.is_dir() {
        "dir"
    } else if ft.is_file() {
        "file"
    } else {
        "other"
    }
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .map(|v| (v * 1000.0).round() / 1000.0)
        .unwrap_or(0.0)
}

#[cfg(unix)]
fn mode_ino(meta: &fs::Metadata) -> (u32, Option<String>, Option<String>) {
    use std::os::unix::fs::MetadataExt;
    (
        meta.mode(),
        Some(meta.ino().to_string()),
        Some(meta.dev().to_string()),
    )
}

#[cfg(not(unix))]
fn mode_ino(meta: &fs::Metadata) -> (u32, Option<String>, Option<String>) {
    let base = if meta.is_dir() { 0o755 } else { 0o644 };
    let mode = if meta.permissions().readonly() {
        base & !0o222
    } else {
        base
    };
    (mode, None, None)
}

pub fn stat_json(meta: &fs::Metadata) -> Value {
    let (mode, ino, dev) = mode_ino(meta);
    let mut v = json!({
        "type": file_type(meta),
        "size": meta.len(),
        "mtimeMs": mtime_ms(meta),
        "mode": mode,
    });
    if let Some(ino) = ino {
        v["ino"] = json!(ino);
    }
    if let Some(dev) = dev {
        v["dev"] = json!(dev);
    }
    v
}

/// Strip the Windows verbatim prefix produced by canonicalize.
pub fn clean_path(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest.to_string());
        }
    }
    p
}

pub fn path_string(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

async fn blocking<T, F>(f: F) -> Result<T, OpError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, OpError> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| OpError::new("EIO", format!("task failed: {e}")))?
}

pub async fn stat(s: &Arc<Session>, a: Args<'_>) -> OpResult {
    let path = s.resolve(a.str("path")?, a.opt_str("cwd"));
    let follow = a.bool("follow", true);
    blocking(move || {
        let meta = if follow {
            fs::metadata(&path)
        } else {
            fs::symlink_metadata(&path)
        };
        match meta {
            Ok(m) => ok(stat_json(&m)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => ok(Value::Null),
            Err(e)
                if e.raw_os_error() == Some(20)
                    || e.raw_os_error() == Some(3)
                    || e.raw_os_error() == Some(267) =>
            {
                ok(Value::Null)
            }
            Err(e) => Err(e.into()),
        }
    })
    .await
}

pub async fn readdir(s: &Arc<Session>, a: Args<'_>) -> OpResult {
    let path = s.resolve(a.str("path")?, a.opt_str("cwd"));
    blocking(move || {
        let meta = fs::metadata(&path)?;
        if !meta.is_dir() {
            return Err(OpError::new(
                "ENOTDIR",
                format!("not a directory: {}", path.display()),
            ));
        }
        let mut entries = Vec::new();
        for entry in fs::read_dir(&path)? {
            let Ok(entry) = entry else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            let mut item = json!({ "name": name });
            if let Ok(lm) = entry.metadata() {
                let mut ty = file_type(&lm);
                let mut meta = lm;
                if ty == "symlink" {
                    if let Ok(target) = fs::metadata(entry.path()) {
                        // Report symlinks as symlink but carry target size/mtime when available.
                        meta = target;
                    } else {
                        ty = "symlink";
                    }
                }
                item["type"] = json!(ty);
                item["size"] = json!(meta.len());
                item["mtimeMs"] = json!(mtime_ms(&meta));
            } else {
                item["type"] = json!("other");
            }
            entries.push(item);
        }
        entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        ok(json!({ "entries": entries }))
    })
    .await
}

pub async fn read(s: &Arc<Session>, a: Args<'_>) -> OpResult {
    let path = s.resolve(a.str("path")?, a.opt_str("cwd"));
    let offset = a.opt_u64("offset").unwrap_or(0);
    let length = a.opt_u64("length");
    let max = a.opt_u64("max").unwrap_or(DEFAULT_MAX).min(DEFAULT_MAX);
    blocking(move || {
        let mut f = fs::File::open(&path)?;
        let meta = f.metadata()?;
        if meta.is_dir() {
            return Err(OpError::new(
                "EISDIR",
                format!("is a directory: {}", path.display()),
            ));
        }
        let size = meta.len();
        let available = size.saturating_sub(offset);
        let want = match length {
            Some(l) => l.min(available),
            None => available,
        };
        if want > max {
            return Err(OpError::new(
                "ETOOBIG",
                format!("{} bytes exceeds limit {}", want, max),
            ));
        }
        f.seek(SeekFrom::Start(offset))?;
        let mut buf = Vec::with_capacity(want as usize);
        Read::by_ref(&mut f).take(want).read_to_end(&mut buf)?;
        let eof = offset + buf.len() as u64 >= size;
        Ok((json!({ "size": size, "eof": eof }), buf))
    })
    .await
}

fn temp_sibling(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let rnd: u64 = crate::util::random_u64();
    path.with_file_name(format!(".{name}.dsh-tmp-{rnd:016x}"))
}

fn ensure_parent(path: &Path, mkdirs: bool) -> Result<(), OpError> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
        && !parent.exists()
    {
        if mkdirs {
            fs::create_dir_all(parent)?;
        } else {
            return Err(OpError::new(
                "ENOENT",
                format!("parent directory does not exist: {}", parent.display()),
            ));
        }
    }
    Ok(())
}

fn rename_replace(from: &Path, to: &Path) -> io::Result<()> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Windows refuses to replace read-only targets; retry once after clearing the flag.
            if to.exists()
                && let Ok(meta) = fs::metadata(to)
            {
                let mut p = meta.permissions();
                if p.readonly() {
                    #[allow(clippy::permissions_set_readonly_false)]
                    p.set_readonly(false);
                    let _ = fs::set_permissions(to, p);
                    return fs::rename(from, to);
                }
            }
            Err(e)
        }
    }
}

pub fn write_file(
    path: &Path,
    mode: &str,
    atomic: bool,
    mkdirs: bool,
    data: &[u8],
) -> Result<Value, OpError> {
    ensure_parent(path, mkdirs)?;
    if let Ok(meta) = fs::metadata(path) {
        if meta.is_dir() {
            return Err(OpError::new(
                "EISDIR",
                format!("is a directory: {}", path.display()),
            ));
        }
        if mode == "create" {
            return Err(OpError::new(
                "EEXIST",
                format!("already exists: {}", path.display()),
            ));
        }
    }
    match mode {
        "append" => {
            let mut f = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)?;
            f.write_all(data)?;
        }
        "create" | "overwrite" => {
            if atomic {
                let tmp = temp_sibling(path);
                let res = (|| -> io::Result<()> {
                    let mut f = fs::File::create(&tmp)?;
                    f.write_all(data)?;
                    f.sync_all()?;
                    drop(f);
                    if mode == "create" && path.exists() {
                        return Err(io::Error::new(
                            io::ErrorKind::AlreadyExists,
                            "already exists",
                        ));
                    }
                    rename_replace(&tmp, path)
                })();
                if let Err(e) = res {
                    let _ = fs::remove_file(&tmp);
                    return Err(e.into());
                }
            } else if mode == "create" {
                let mut f = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)?;
                f.write_all(data)?;
            } else {
                fs::write(path, data)?;
            }
        }
        other => return Err(OpError::invalid(format!("unknown write mode `{other}`"))),
    }
    Ok(stat_json(&fs::metadata(path)?))
}

pub async fn write(s: &Arc<Session>, a: Args<'_>, payload: Vec<u8>) -> OpResult {
    let path = s.resolve(a.str("path")?, a.opt_str("cwd"));
    let mode = a.opt_str("mode").unwrap_or("overwrite").to_string();
    let atomic = a.bool("atomic", true);
    let mkdirs = a.bool("mkdirs", false);
    blocking(move || ok(write_file(&path, &mode, atomic, mkdirs, &payload)?)).await
}

pub async fn mkdir(s: &Arc<Session>, a: Args<'_>) -> OpResult {
    let path = s.resolve(a.str("path")?, a.opt_str("cwd"));
    let recursive = a.bool("recursive", false);
    blocking(move || {
        if recursive {
            fs::create_dir_all(&path)?;
        } else {
            fs::create_dir(&path)?;
        }
        ok(json!({}))
    })
    .await
}

pub async fn remove(s: &Arc<Session>, a: Args<'_>) -> OpResult {
    let path = s.resolve(a.str("path")?, a.opt_str("cwd"));
    let recursive = a.bool("recursive", false);
    blocking(move || {
        let meta = fs::symlink_metadata(&path)?;
        if meta.is_dir() {
            if recursive {
                fs::remove_dir_all(&path)?;
            } else {
                fs::remove_dir(&path)?;
            }
        } else {
            match fs::remove_file(&path) {
                Ok(()) => {}
                // Directory symlinks / junctions on Windows.
                Err(e) if meta.file_type().is_symlink() => fs::remove_dir(&path).map_err(|_| e)?,
                Err(e) => return Err(e.into()),
            }
        }
        ok(json!({}))
    })
    .await
}

pub async fn rename(s: &Arc<Session>, a: Args<'_>) -> OpResult {
    let from = s.resolve(a.str("from")?, a.opt_str("cwd"));
    let to = s.resolve(a.str("to")?, a.opt_str("cwd"));
    let overwrite = a.bool("overwrite", false);
    blocking(move || {
        fs::symlink_metadata(&from)?;
        if !overwrite && fs::symlink_metadata(&to).is_ok() {
            return Err(OpError::new(
                "EEXIST",
                format!("already exists: {}", to.display()),
            ));
        }
        rename_replace(&from, &to)?;
        ok(json!({}))
    })
    .await
}

fn copy_recursive(from: &Path, to: &Path, overwrite: bool) -> Result<(), OpError> {
    let meta = fs::metadata(from)?;
    if meta.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()), overwrite)?;
        }
    } else {
        if !overwrite && to.exists() {
            return Err(OpError::new(
                "EEXIST",
                format!("already exists: {}", to.display()),
            ));
        }
        fs::copy(from, to)?;
    }
    Ok(())
}

pub async fn copy(s: &Arc<Session>, a: Args<'_>) -> OpResult {
    let from = s.resolve(a.str("from")?, a.opt_str("cwd"));
    let to = s.resolve(a.str("to")?, a.opt_str("cwd"));
    let recursive = a.bool("recursive", false);
    let overwrite = a.bool("overwrite", false);
    blocking(move || {
        let meta = fs::metadata(&from)?;
        if meta.is_dir() && !recursive {
            return Err(OpError::new(
                "EISDIR",
                "source is a directory; pass recursive",
            ));
        }
        copy_recursive(&from, &to, overwrite)?;
        ok(json!({}))
    })
    .await
}

pub async fn realpath(s: &Arc<Session>, a: Args<'_>) -> OpResult {
    let path = s.resolve(a.str("path")?, a.opt_str("cwd"));
    blocking(move || {
        let real = clean_path(fs::canonicalize(&path)?);
        ok(json!({ "path": path_string(&real) }))
    })
    .await
}

pub async fn read_stream(s: &Arc<Session>, a: Args<'_>) -> OpResult {
    let path = s.resolve(a.str("path")?, a.opt_str("cwd"));
    let file = tokio::fs::File::open(&path).await?;
    let meta = file.metadata().await?;
    if meta.is_dir() {
        return Err(OpError::new(
            "EISDIR",
            format!("is a directory: {}", path.display()),
        ));
    }
    let handle = s.open_channel(&[1], None);
    let ch = handle.ch;
    let sess = s.clone();
    let task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut file = file;
        let _inbound = handle.inbound;
        let mut buf = vec![0u8; crate::protocol::CHUNK];
        loop {
            match file.read(&mut buf).await {
                Ok(0) => {
                    sess.send_eof(ch, None);
                    sess.close_channel(ch, None, None);
                    break;
                }
                Ok(n) => {
                    if !sess.send_data(ch, None, buf[..n].to_vec()).await {
                        break;
                    }
                }
                Err(e) => {
                    sess.close_channel(ch, None, Some(e.into()));
                    break;
                }
            }
        }
    });
    s.attach_task(ch, task.abort_handle());
    ok(json!({ "ch": ch, "size": meta.len() }))
}

pub async fn write_stream(s: &Arc<Session>, a: Args<'_>) -> OpResult {
    let path = s.resolve(a.str("path")?, a.opt_str("cwd"));
    let atomic = a.bool("atomic", true);
    let mkdirs = a.bool("mkdirs", false);
    {
        let p = path.clone();
        blocking(move || ensure_parent(&p, mkdirs)).await?;
    }
    if let Ok(meta) = tokio::fs::metadata(&path).await
        && meta.is_dir()
    {
        return Err(OpError::new(
            "EISDIR",
            format!("is a directory: {}", path.display()),
        ));
    }
    let target = if atomic {
        temp_sibling(&path)
    } else {
        path.clone()
    };
    let file = tokio::fs::File::create(&target).await?;
    let mut handle = s.open_channel(&[], None);
    let ch = handle.ch;
    let sess = s.clone();
    let task = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let mut file = file;
        let cleanup = |sess: &Session, err: OpError| {
            if atomic {
                let _ = std::fs::remove_file(&target);
            }
            sess.close_channel(ch, None, Some(err));
        };
        loop {
            match handle.inbound.recv().await {
                Some(Inbound::Data(_, data)) => {
                    let n = data.len();
                    if let Err(e) = file.write_all(&data).await {
                        cleanup(&sess, e.into());
                        return;
                    }
                    sess.grant(ch, None, n);
                }
                Some(Inbound::Eof(_)) => {
                    let finish = async {
                        file.flush().await?;
                        file.sync_all().await?;
                        drop(file);
                        if atomic {
                            let (t, p) = (target.clone(), path.clone());
                            tokio::task::spawn_blocking(move || rename_replace(&t, &p))
                                .await
                                .map_err(|e| io::Error::other(e.to_string()))??;
                        }
                        let meta = tokio::fs::metadata(&path).await?;
                        Ok::<Value, io::Error>(stat_json(&meta))
                    };
                    match finish.await {
                        Ok(stat) => sess.close_channel(ch, Some(stat), None),
                        Err(e) => cleanup(&sess, e.into()),
                    }
                    return;
                }
                Some(Inbound::Close) | None => {
                    drop(file);
                    if atomic {
                        let _ = tokio::fs::remove_file(&target).await;
                    }
                    return;
                }
            }
        }
    });
    s.attach_task(ch, task.abort_handle());
    ok(json!({ "ch": ch }))
}
