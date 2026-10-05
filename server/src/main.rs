#![allow(dead_code)]
mod fs_ops;
mod net;
mod ops;
mod proc;
mod protocol;
mod search;
mod session;
mod sys;
mod winuser;

use clap::{Parser, Subcommand};
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Parser, Debug)]
#[command(name = "dsh-env-server", version, about = "Remote environment server for the DeepSeek Harness environments plugin")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Serve the environment protocol over TCP.
    Serve {
        /// Address to listen on, e.g. 0.0.0.0:7461 or 127.0.0.1:0.
        #[arg(long, default_value = "127.0.0.1:7461")]
        listen: String,
        /// Shared secret clients must present.
        #[arg(long)]
        token: Option<String>,
        /// Read the shared secret from a file.
        #[arg(long)]
        token_file: Option<PathBuf>,
        /// Working directory for relative paths.
        #[arg(long)]
        cwd: Option<PathBuf>,
        /// Exit after the first connection ends.
        #[arg(long)]
        once: bool,
    },
    /// Serve exactly one session on stdin/stdout.
    Stdio {
        #[arg(long)]
        cwd: Option<PathBuf>,
    },
    /// Manage dsh-managed local Windows accounts.
    Winuser {
        #[command(subcommand)]
        cmd: winuser::WinUserCmd,
    },
}

fn resolve_cwd(cwd: Option<PathBuf>) -> PathBuf {
    let cwd = cwd.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    std::fs::canonicalize(&cwd).map(fs_ops::clean_path).unwrap_or(cwd)
}

fn main() {
    let cli = Cli::parse();
    #[cfg(windows)]
    sys::win::init_dpi();
    let code = match cli.cmd {
        Cmd::Winuser { cmd } => match winuser::run(cmd) {
            Ok(v) => {
                println!("{v}");
                0
            }
            Err(e) => {
                println!("{}", serde_json::json!({"ok": false, "error": format!("{e:#}")}));
                1
            }
        },
        Cmd::Serve { listen, token, token_file, cwd, once } => {
            let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
            match rt.block_on(serve(listen, token, token_file, resolve_cwd(cwd), once)) {
                Ok(()) => 0,
                Err(e) => {
                    eprintln!("dsh-env-server: {e:#}");
                    1
                }
            }
        }
        Cmd::Stdio { cwd } => {
            let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
            let cwd = resolve_cwd(cwd);
            let r = rt.block_on(async move {
                let opts = session::ConnOptions { token: None, cwd, idle_timeout: None };
                session::serve_connection(tokio::io::stdin(), tokio::io::stdout(), opts).await
            });
            rt.shutdown_timeout(Duration::from_millis(500));
            match r {
                Ok(()) => 0,
                Err(e) => {
                    eprintln!("dsh-env-server: {e:#}");
                    1
                }
            }
        }
    };
    std::process::exit(code);
}

async fn serve(listen: String, token: Option<String>, token_file: Option<PathBuf>, cwd: PathBuf, once: bool) -> anyhow::Result<()> {
    let token = match (token, token_file) {
        (Some(t), _) => t,
        (None, Some(f)) => std::fs::read_to_string(f)?.trim().to_string(),
        (None, None) => {
            let bytes: [u8; 32] = rand::random();
            let t: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            println!("DSH_ENV_SERVER token={t}");
            t
        }
    };
    let listener = tokio::net::TcpListener::bind(&listen).await?;
    println!("DSH_ENV_SERVER listening={}", listener.local_addr()?);
    std::io::stdout().flush()?;
    loop {
        let (stream, peer) = listener.accept().await?;
        let _ = stream.set_nodelay(true);
        let token = token.clone();
        let cwd = cwd.clone();
        let task = tokio::spawn(async move {
            let (r, w) = stream.into_split();
            let opts = session::ConnOptions { token: Some(token), cwd, idle_timeout: Some(Duration::from_secs(60)) };
            if let Err(e) = session::serve_connection(r, w, opts).await {
                eprintln!("dsh-env-server: session {peer} ended: {e:#}");
            }
        });
        if once {
            let _ = task.await;
            return Ok(());
        }
    }
}
