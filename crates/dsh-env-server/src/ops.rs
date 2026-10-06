//! Operation dispatch.

use crate::protocol::{Args, OpError, OpResult};
use crate::session::{Session, ok};
use serde_json::{Value, json};
use std::sync::Arc;

pub async fn dispatch(s: &Arc<Session>, op: &str, args: &Value, payload: Vec<u8>) -> OpResult {
    match op {
        "sys.info" => ok(s.info.clone()),
        "sys.screenshot" => crate::sys::screenshot(Args(args)).await,
        "sys.input" => crate::sys::input(Args(args)).await,
        "sys.displays" => crate::sys::displays(Args(args)).await,
        "sys.windows" => crate::sys::windows(Args(args)).await,
        "sys.window" => crate::sys::window(Args(args)).await,
        "fs.stat" => crate::fs_ops::stat(s, Args(args)).await,
        "fs.readdir" => crate::fs_ops::readdir(s, Args(args)).await,
        "fs.read" => crate::fs_ops::read(s, Args(args)).await,
        "fs.write" => crate::fs_ops::write(s, Args(args), payload).await,
        "fs.mkdir" => crate::fs_ops::mkdir(s, Args(args)).await,
        "fs.remove" => crate::fs_ops::remove(s, Args(args)).await,
        "fs.rename" => crate::fs_ops::rename(s, Args(args)).await,
        "fs.copy" => crate::fs_ops::copy(s, Args(args)).await,
        "fs.realpath" => crate::fs_ops::realpath(s, Args(args)).await,
        "fs.readStream" => crate::fs_ops::read_stream(s, Args(args)).await,
        "fs.writeStream" => crate::fs_ops::write_stream(s, Args(args)).await,
        "fs.glob" => crate::search::glob(s, args.clone()).await,
        "fs.grep" => crate::search::grep(s, args.clone()).await,
        "proc.spawn" => crate::proc::spawn(s, Args(args)).await,
        "proc.resize" => {
            let a = Args(args);
            let ctl = s.control(a.u64("ch")?)?;
            ctl.resize(a.u64("rows")? as u16, a.u64("cols")? as u16)?;
            ok(json!({}))
        }
        "proc.kill" => {
            let a = Args(args);
            let ctl = s.control(a.u64("ch")?)?;
            ctl.kill(a.opt_str("signal").unwrap_or("KILL"))?;
            ok(json!({}))
        }
        "net.connect" => crate::net::connect(s, Args(args)).await,
        "net.listen" => crate::net::listen(s, Args(args)).await,
        "net.unlisten" => {
            let id = Args(args).u64("id")?;
            if s.remove_listener(id) {
                ok(json!({}))
            } else {
                Err(OpError::invalid(format!("unknown listener {id}")))
            }
        }
        _ => Err(OpError::unsupported(format!("unknown op `{op}`"))),
    }
}
