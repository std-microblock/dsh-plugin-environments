#![allow(dead_code)]
mod cli;
mod fs_ops;
mod net;
mod ops;
mod proc;
mod protocol;
mod pty;
mod search;
mod secure;
mod session;
mod sys;
mod transport;
mod util;
mod walk;
mod winuser;
mod ws;

use cli::Cmd;
use std::path::PathBuf;
use std::sync::Arc;
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
            secret,
            cwd,
            once,
            exit_idle,
            lifeline,
        } => run(
            lifeline,
            Box::new(move |life| {
                Box::pin(async move {
                    let listen = transport::Endpoint::parse(&listen).map_err(invalid_input)?;
                    let secret =
                        match transport::read_secret(secret.token, secret.file, secret.stdin)? {
                            Some(s) => s,
                            None => {
                                let mut bytes = [0u8; 32];
                                util::random_bytes(&mut bytes);
                                let t = util::hex(&bytes);
                                println!("DSH_ENV_SERVER token={t}");
                                t
                            }
                        };
                    let opts = transport::ServeOptions {
                        listen,
                        secret,
                        cwd: resolve_cwd(cwd),
                        once,
                        exit_idle,
                    };
                    transport::serve(opts, life).await
                })
            }),
        ),
        Cmd::Connect {
            url,
            id,
            secret,
            cwd,
            lifeline,
        } => run(
            lifeline,
            Box::new(move |life| {
                Box::pin(async move {
                    let url = transport::Endpoint::parse(&url).map_err(invalid_input)?;
                    let secret = transport::read_secret(secret.token, secret.file, secret.stdin)?
                        .ok_or_else(|| invalid_input("a secret is required".into()))?;
                    let opts = transport::ConnectOptions {
                        url,
                        secret,
                        id,
                        cwd: resolve_cwd(cwd),
                        max_sessions: 32,
                    };
                    transport::connect(opts, life).await
                })
            }),
        ),
        Cmd::Stdio { cwd } => {
            let rt = runtime();
            let cwd = resolve_cwd(cwd);
            let r = rt.block_on(async move {
                let opts = session::ConnOptions {
                    token: None,
                    cwd,
                    idle_timeout: None,
                    shutdown: None,
                    on_hello: None,
                };
                session::serve_connection(
                    Box::new(tokio::io::stdin()),
                    Box::new(tokio::io::stdout()),
                    opts,
                )
                .await
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

fn invalid_input(msg: String) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, msg)
}

/// Run a network command, then shut every session down (killing their process trees) before
/// the process exits.
type CmdFuture = std::pin::Pin<Box<dyn Future<Output = std::io::Result<()>>>>;

fn run(lifeline: bool, f: Box<dyn FnOnce(Arc<transport::Lifetime>) -> CmdFuture>) -> i32 {
    let rt = runtime();
    let code = rt.block_on(async move {
        let life = transport::Lifetime::new();
        if lifeline {
            life.lifeline();
        }
        let r = f(life.clone()).await;
        life.trigger();
        life.drain(Duration::from_secs(5)).await;
        match r {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("dsh-env-server: {e}");
                1
            }
        }
    });
    rt.shutdown_timeout(Duration::from_millis(500));
    code
}
