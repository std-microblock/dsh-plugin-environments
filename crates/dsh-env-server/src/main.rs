#![allow(dead_code)]
mod cli;
mod fs_ops;
mod input;
mod net;
mod ops;
mod proc;
mod protocol;
mod pty;
mod screen;
mod search;
mod session;
mod sys;
mod util;
mod walk;
mod winuser;

use cli::Cmd;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

fn resolve_cwd(cwd: Option<PathBuf>) -> PathBuf {
    let cwd = cwd.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    std::fs::canonicalize(&cwd)
        .map(fs_ops::clean_path)
        .unwrap_or(cwd)
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(64)
        .build()
        .expect("tokio runtime")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = match cli::parse(&args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: {e}\n\n{}", cli::USAGE);
            std::process::exit(2);
        }
    };
    #[cfg(windows)]
    sys::win::init_dpi();
    let code = match cmd {
        Cmd::Help => {
            print!("{}", cli::USAGE);
            0
        }
        Cmd::Version => {
            println!("dsh-env-server {}", sys::VERSION);
            0
        }
        Cmd::Winuser(cmd) => match winuser::run(cmd) {
            Ok(v) => {
                println!("{v}");
                0
            }
            Err(e) => {
                println!("{}", serde_json::json!({"ok": false, "error": e}));
                1
            }
        },
        Cmd::Serve {
            listen,
            token,
            token_file,
            cwd,
            once,
        } => {
            let rt = runtime();
            match rt.block_on(serve(listen, token, token_file, resolve_cwd(cwd), once)) {
                Ok(()) => 0,
                Err(e) => {
                    eprintln!("dsh-env-server: {e}");
                    1
                }
            }
        }
        Cmd::Stdio { cwd } => {
            let rt = runtime();
            let cwd = resolve_cwd(cwd);
            let r = rt.block_on(async move {
                let opts = session::ConnOptions {
                    token: None,
                    cwd,
                    idle_timeout: None,
                };
                session::serve_connection(tokio::io::stdin(), tokio::io::stdout(), opts).await
            });
            rt.shutdown_timeout(Duration::from_millis(500));
            match r {
                Ok(()) => 0,
                Err(e) => {
                    eprintln!("dsh-env-server: {e}");
                    1
                }
            }
        }
    };
    std::process::exit(code);
}

async fn serve(
    listen: String,
    token: Option<String>,
    token_file: Option<PathBuf>,
    cwd: PathBuf,
    once: bool,
) -> std::io::Result<()> {
    let token = match (token, token_file) {
        (Some(t), _) => t,
        (None, Some(f)) => std::fs::read_to_string(f)?.trim().to_string(),
        (None, None) => {
            let mut bytes = [0u8; 32];
            util::random_bytes(&mut bytes);
            let t = util::hex(&bytes);
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
            let opts = session::ConnOptions {
                token: Some(token),
                cwd,
                idle_timeout: Some(Duration::from_secs(60)),
            };
            if let Err(e) = session::serve_connection(r, w, opts).await {
                eprintln!("dsh-env-server: session {peer} ended: {e}");
            }
        });
        if once {
            let _ = task.await;
            return Ok(());
        }
    }
}
