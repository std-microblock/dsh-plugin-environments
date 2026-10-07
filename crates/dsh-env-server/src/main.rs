#![allow(dead_code)]
mod cli;
mod desktop;
mod fs_ops;
mod input;
mod net;
mod ops;
mod proc;
mod protocol;
mod pty;
mod screen;
mod search;
mod secure;
mod session;
mod session_status;
mod sys;
mod termwrap;
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
    // `~` is the home directory of whoever runs the server (e.g. a winuser account).
    let home = || std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    let cwd = match cwd {
        Some(p) if p.as_os_str() == "~" => home().map(PathBuf::from),
        other => other,
    };
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
    #[cfg(windows)]
    {
        let raw: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
        if raw.first().is_some_and(|a| a == proc::UTF8_TRAMPOLINE) {
            std::process::exit(proc::utf8_trampoline(&raw[1..]));
        }
    }
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
        Cmd::Session(cmd) => match session_status::run(cmd) {
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
        } => {
            // Read the secret before `run` starts the lifeline watcher: both read stdin, and if the
            // watcher wins the race it swallows the secret line, leaving this read blocked forever.
            let secret = match transport::read_secret(secret.token, secret.file, secret.stdin) {
                Ok(Some(s)) => s,
                Ok(None) => {
                    let mut bytes = [0u8; 32];
                    util::random_bytes(&mut bytes);
                    let t = util::hex(&bytes);
                    println!("DSH_ENV_SERVER token={t}");
                    t
                }
                Err(e) => {
                    eprintln!("dsh-env-server: {e}");
                    std::process::exit(1);
                }
            };
            run(
                lifeline,
                Box::new(move |life| {
                    Box::pin(async move {
                        let listen = transport::Endpoint::parse(&listen).map_err(invalid_input)?;
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
            )
        }
        Cmd::Connect {
            url,
            id,
            secret,
            cwd,
            lifeline,
        } => {
            // Same ordering requirement as `serve` above: the secret must be consumed before the
            // lifeline thread starts reading stdin.
            let secret = match transport::read_secret(secret.token, secret.file, secret.stdin) {
                Ok(Some(s)) => s,
                Ok(None) => {
                    eprintln!("dsh-env-server: a secret is required");
                    std::process::exit(1);
                }
                Err(e) => {
                    eprintln!("dsh-env-server: {e}");
                    std::process::exit(1);
                }
            };
            run(
                lifeline,
                Box::new(move |life| {
                    Box::pin(async move {
                        let url = transport::Endpoint::parse(&url).map_err(invalid_input)?;
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
            )
        }
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
