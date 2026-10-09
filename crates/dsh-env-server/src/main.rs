#![allow(dead_code)]
mod cli;
mod desktop;
#[cfg(windows)]
mod elevate;
mod fs_ops;
mod input;
mod net;
mod ops;
mod proc;
mod protocol;
mod pty;
#[cfg(windows)]
mod rdp;
mod screen;
mod search;
mod secure;
mod session;
mod session_status;
mod sys;
mod termwrap;
mod transport;
mod util;
mod winuser;
mod ws;

use anyhow::Context;
use clap::Parser;
use cli::{Cli, Cmd};
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
        // Hidden trampoline (see proc.rs); handled before clap so the program's own
        // arguments are passed through untouched.
        let raw: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
        if raw.first().is_some_and(|a| a == proc::UTF8_TRAMPOLINE) {
            std::process::exit(proc::utf8_trampoline(&raw[1..]));
        }
    }
    let cmd = Cli::parse().cmd;
    #[cfg(windows)]
    sys::win::init_dpi();
    let code = match cmd {
        Cmd::Winuser(cmd) => match winuser::run(cmd) {
            Ok(v) => {
                println!("{v}");
                0
            }
            Err(e) => {
                println!(
                    "{}",
                    serde_json::json!({"ok": false, "error": format!("{e:#}")})
                );
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
            no_console,
            end_session,
        } => {
            // Separate-session mode starts this process as the account's logon shell, and Windows
            // gives a console application a console: on Windows 11 that is a visible Windows
            // Terminal window sitting on the account's desktop (and stealing focus). The server
            // talks over TCP and needs no console, so detach from it.
            #[cfg(windows)]
            if no_console {
                unsafe {
                    windows_sys::Win32::System::Console::FreeConsole();
                }
            }
            #[cfg(not(windows))]
            let _ = no_console;
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
                    eprintln!("dsh-env-server: {e:#}");
                    std::process::exit(1);
                }
            };
            let code = run(
                lifeline,
                Box::new(move |life| {
                    Box::pin(async move {
                        let listen = transport::Endpoint::parse(&listen).context("--listen")?;
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
            );
            // Separate-session mode: this process is the account's logon shell, and Windows does not
            // necessarily end the session when its shell exits (it can sit at the logon screen
            // instead). A session left behind is worse than useless: the next logon reconnects to it
            // and never runs the shell again.
            #[cfg(windows)]
            if end_session {
                session_status::end_current_session();
            }
            #[cfg(not(windows))]
            let _ = end_session;
            code
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
                    eprintln!("dsh-env-server: {e:#}");
                    std::process::exit(1);
                }
            };
            run(
                lifeline,
                Box::new(move |life| {
                    Box::pin(async move {
                        let url = transport::Endpoint::parse(&url).context("<URL>")?;
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
        Cmd::Elevate { program } => {
            #[cfg(windows)]
            {
                match elevate::run(&program) {
                    Ok(code) => code,
                    Err(e) => {
                        eprintln!("dsh-env-server: {e:#}");
                        1
                    }
                }
            }
            #[cfg(not(windows))]
            {
                let _ = program;
                eprintln!("dsh-env-server: elevation is only implemented on Windows");
                1
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

/// Run a network command, then shut every session down (killing their process trees) before
/// the process exits.
type CmdFuture = std::pin::Pin<Box<dyn Future<Output = anyhow::Result<()>>>>;

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
                eprintln!("dsh-env-server: {e:#}");
                1
            }
        }
    });
    rt.shutdown_timeout(Duration::from_millis(500));
    code
}
