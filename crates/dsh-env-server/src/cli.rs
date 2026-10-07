//! Command-line interface (clap derive).
//!
//! The plugin builds these argument lists itself (`packages/plugin/src`: `serve`,
//! `connect`, `stdio`, `winuser ...`), so flag names are part of its contract. The
//! hidden `__utf8-console` trampoline is handled in `main` before clap runs.

use clap::{ArgGroup, Args, Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser, Debug, PartialEq)]
#[command(
    name = "dsh-env-server",
    version,
    about = "Remote environment server for the DeepSeek Harness environments plugin",
    disable_help_subcommand = true
)]
pub struct Cli {
    #[command(subcommand)]
    pub cmd: Cmd,
}

/// Where the shared secret comes from (at most one source).
#[derive(Args, Debug, PartialEq, Default)]
#[group(id = "secret", multiple = false)]
pub struct SecretSource {
    /// Shared secret (visible to other users in `ps`; prefer --token-stdin)
    #[arg(long, value_name = "TOKEN")]
    pub token: Option<String>,
    /// Read the shared secret from a file
    #[arg(long = "token-file", value_name = "PATH")]
    pub file: Option<PathBuf>,
    /// Read the shared secret from the first line of stdin
    #[arg(long = "token-stdin")]
    pub stdin: bool,
}

#[derive(Subcommand, Debug, PartialEq)]
pub enum Cmd {
    /// Listen for the plugin (TCP or WebSocket, always over the secure channel)
    ///
    /// Without a secret a random one is generated and printed.
    Serve {
        /// host:port, tcp://host:port or ws://host:port/path
        #[arg(long, value_name = "ADDR", default_value = "127.0.0.1:7461")]
        listen: String,
        #[command(flatten)]
        secret: SecretSource,
        /// Working directory for relative paths (`~` = home)
        #[arg(long, value_name = "PATH")]
        cwd: Option<PathBuf>,
        /// Exit after the first connection ends
        #[arg(long)]
        once: bool,
        /// Exit when the last session ends
        #[arg(long = "exit-idle")]
        exit_idle: bool,
        /// Exit (killing every spawned process) when stdin closes
        #[arg(long)]
        lifeline: bool,
        /// Detach from the console Windows allocated for this process (session shell: keeps a
        /// console window off the account's desktop)
        #[arg(long = "no-console")]
        no_console: bool,
        /// End this Windows session when the server exits (session shell: a finished environment
        /// must not leave a logged-on session behind for the next logon to reconnect to)
        #[arg(long = "end-session")]
        end_session: bool,
    },
    /// Dial the plugin (reverse connection), reconnecting with backoff
    #[command(group(ArgGroup::new("secret-required").args(["token", "file", "stdin"]).required(true)))]
    Connect {
        /// tcp://host:port or ws://host:port/path
        url: String,
        /// Environment id configured in the plugin
        #[arg(long)]
        id: String,
        #[command(flatten)]
        secret: SecretSource,
        /// Working directory for relative paths (`~` = home)
        #[arg(long, value_name = "PATH")]
        cwd: Option<PathBuf>,
        /// Exit (killing every spawned process) when stdin closes
        #[arg(long)]
        lifeline: bool,
    },
    /// Serve exactly one session on stdin/stdout
    Stdio {
        /// Working directory for relative paths (`~` = home)
        #[arg(long, value_name = "PATH")]
        cwd: Option<PathBuf>,
    },
    /// Manage dsh-managed local Windows accounts
    #[command(subcommand)]
    Winuser(WinUserCmd),
    /// Real-session mode: one real Windows session per isolated account
    #[command(subcommand)]
    Session(SessionCmd),
}

/// Real-session mode (one Windows session per isolated account).
#[derive(Subcommand, Debug, PartialEq)]
pub enum SessionCmd {
    /// Report whether this machine can host a real separate session, and why not
    Status,
    /// Install the bundled TermWrap payload and enable the Remote Desktop host (elevated)
    Install {
        #[arg(long, value_name = "DIR")]
        payload: String,
        #[arg(long, value_name = "DIR")]
        target: Option<String>,
        /// Add a Defender exclusion for the install directory first (default on)
        #[arg(long = "no-exclusion", action = clap::ArgAction::SetFalse)]
        exclusion: bool,
    },
    /// Let an account log on through Remote Desktop (elevated)
    Allow {
        #[arg(long)]
        account: String,
    },
    /// End every session of an account (elevated), so the next logon creates a fresh one
    Logoff {
        #[arg(long)]
        account: String,
    },
    /// Enable the Remote Desktop host without the patch (Server SKUs; elevated)
    Enable,
}

#[derive(Subcommand, Debug, PartialEq)]
pub enum WinUserCmd {
    /// Create an account and store its DPAPI-protected password
    Create {
        #[arg(long)]
        name: String,
        #[arg(long = "secret-out", value_name = "PATH")]
        secret_out: String,
    },
    /// Delete a dsh-managed account
    Delete {
        #[arg(long)]
        name: String,
        /// Also remove the account's profile directory
        #[arg(long = "purge-profile")]
        purge_profile: bool,
    },
    /// List dsh-managed accounts (JSON)
    List,
    /// Start a program as the account on the interactive desktop
    Launch {
        #[arg(long)]
        name: String,
        #[arg(long = "secret-file", value_name = "PATH")]
        secret_file: String,
        #[arg(long, value_name = "PATH")]
        cwd: Option<String>,
        /// Desktop to start the program on (`winsta0\<NAME>`), created if missing and kept
        /// alive for as long as this launcher runs. Absent = the caller's own desktop.
        #[arg(long, value_name = "NAME")]
        desktop: Option<String>,
        /// Stay alive, holding the process in a kill-on-close job, until it exits or
        /// stdin closes
        #[arg(long)]
        supervise: bool,
        /// Program and arguments (after `--`)
        #[arg(last = true, required = true, value_name = "PROGRAM")]
        program: Vec<String>,
    },
    /// Grant the account modify access to a directory tree
    Grant {
        #[arg(long)]
        name: String,
        #[arg(long, value_name = "PATH")]
        path: String,
    },
    /// Log the account on to a session of its own, headlessly, and hold it open
    Session {
        #[arg(long)]
        name: String,
        #[arg(long = "secret-file", value_name = "PATH")]
        secret_file: String,
        /// Program the session runs instead of the desktop shell (normally our own `serve`)
        #[arg(long)]
        shell: Option<String>,
        /// Host of the Remote Desktop listener
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        #[arg(long, default_value_t = 3389)]
        port: u16,
        /// Resolution of the account's own screen
        #[arg(long, default_value_t = 1280)]
        width: u16,
        #[arg(long, default_value_t = 800)]
        height: u16,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    fn p(s: &[&str]) -> Result<Cmd, clap::Error> {
        Cli::try_parse_from(std::iter::once("dsh-env-server").chain(s.iter().copied()))
            .map(|c| c.cmd)
    }

    #[test]
    fn definition_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn serve_defaults_and_values() {
        assert_eq!(
            p(&["serve"]).unwrap(),
            Cmd::Serve {
                listen: "127.0.0.1:7461".into(),
                secret: SecretSource::default(),
                cwd: None,
                once: false,
                exit_idle: false,
                lifeline: false,
                no_console: false,
                end_session: false,
            }
        );
        assert_eq!(
            p(&[
                "serve",
                "--listen=0.0.0.0:1",
                "--token",
                "abc",
                "--once",
                "--cwd",
                "/x"
            ])
            .unwrap(),
            Cmd::Serve {
                listen: "0.0.0.0:1".into(),
                secret: SecretSource {
                    token: Some("abc".into()),
                    ..Default::default()
                },
                cwd: Some("/x".into()),
                once: true,
                exit_idle: false,
                lifeline: false,
                no_console: false,
                end_session: false,
            }
        );
        assert!(p(&["serve", "--bogus"]).is_err());
        assert!(p(&["serve", "--token"]).is_err());
        assert!(p(&["serve", "--token", "a", "--token-stdin"]).is_err());
        assert!(p(&["serve", "--once", "--once"]).is_err());
        match p(&["serve", "--token-stdin", "--lifeline", "--exit-idle"]).unwrap() {
            Cmd::Serve {
                secret,
                lifeline,
                exit_idle,
                ..
            } => {
                assert!(secret.stdin && lifeline && exit_idle);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn connect_args() {
        assert_eq!(
            p(&["connect", "ws://h:1/x", "--id", "e1", "--token-file", "/s"]).unwrap(),
            Cmd::Connect {
                url: "ws://h:1/x".into(),
                id: "e1".into(),
                secret: SecretSource {
                    file: Some("/s".into()),
                    ..Default::default()
                },
                cwd: None,
                lifeline: false,
            }
        );
        // The plugin's argument order (reverse.test.ts / connect.ts).
        assert!(matches!(
            p(&[
                "connect",
                "tcp://h:1",
                "--id",
                "e1",
                "--token-stdin",
                "--lifeline",
                "--cwd",
                "/c"
            ]),
            Ok(Cmd::Connect { lifeline: true, .. })
        ));
        assert!(p(&["connect", "tcp://h:1", "--id", "e1"]).is_err());
        assert!(p(&["connect", "--id", "e1", "--token-stdin"]).is_err());
        assert!(p(&["connect", "tcp://h:1", "--token-stdin"]).is_err());
        assert!(
            p(&[
                "connect",
                "tcp://h:1",
                "--id",
                "e1",
                "--token",
                "a",
                "--token-stdin"
            ])
            .is_err()
        );
    }

    #[test]
    fn stdio_args() {
        assert_eq!(
            p(&["stdio", "--cwd", "/w"]).unwrap(),
            Cmd::Stdio {
                cwd: Some("/w".into())
            }
        );
        assert!(p(&["stdio", "extra"]).is_err());
    }

    #[test]
    fn winuser_launch() {
        assert_eq!(
            p(&[
                "winuser",
                "launch",
                "--name",
                "u",
                "--secret-file",
                "s",
                "--",
                "a.exe",
                "--flag"
            ])
            .unwrap(),
            Cmd::Winuser(WinUserCmd::Launch {
                name: "u".into(),
                secret_file: "s".into(),
                cwd: None,
                desktop: None,
                program: vec!["a.exe".into(), "--flag".into()],
                supervise: false,
            })
        );
        assert_eq!(
            p(&[
                "winuser",
                "launch",
                "--name",
                "u",
                "--secret-file",
                "s",
                "--desktop",
                "dsh-x",
                "--supervise",
                "--",
                "a"
            ])
            .unwrap(),
            Cmd::Winuser(WinUserCmd::Launch {
                name: "u".into(),
                secret_file: "s".into(),
                cwd: None,
                desktop: Some("dsh-x".into()),
                program: vec!["a".into()],
                supervise: true,
            })
        );
        // The plugin's launch line (winuser-env.ts): the program's own flags follow `--`.
        assert_eq!(
            p(&[
                "winuser",
                "launch",
                "--name",
                "u",
                "--secret-file",
                "s",
                "--supervise",
                "--cwd",
                "C:\\w",
                "--",
                "srv.exe",
                "serve",
                "--listen",
                "127.0.0.1:1",
                "--token",
                "t",
                "--once",
                "--cwd",
                "~"
            ])
            .unwrap(),
            Cmd::Winuser(WinUserCmd::Launch {
                name: "u".into(),
                secret_file: "s".into(),
                cwd: Some("C:\\w".into()),
                desktop: None,
                program: [
                    "srv.exe",
                    "serve",
                    "--listen",
                    "127.0.0.1:1",
                    "--token",
                    "t",
                    "--once",
                    "--cwd",
                    "~"
                ]
                .map(String::from)
                .to_vec(),
                supervise: true,
            })
        );
        assert!(p(&["winuser", "launch", "--name", "u", "--secret-file", "s"]).is_err());
        assert_eq!(
            p(&["winuser", "list"]).unwrap(),
            Cmd::Winuser(WinUserCmd::List)
        );
        assert!(p(&["winuser", "create", "--name", "u"]).is_err());
        assert_eq!(
            p(&["winuser", "delete", "--name", "u", "--purge-profile"]).unwrap(),
            Cmd::Winuser(WinUserCmd::Delete {
                name: "u".into(),
                purge_profile: true
            })
        );
        assert_eq!(
            p(&["winuser", "grant", "--name", "u", "--path", "C:\\d"]).unwrap(),
            Cmd::Winuser(WinUserCmd::Grant {
                name: "u".into(),
                path: "C:\\d".into()
            })
        );
    }

    #[test]
    fn help_and_version() {
        use clap::error::ErrorKind;
        assert_eq!(
            p(&["--version"]).unwrap_err().kind(),
            ErrorKind::DisplayVersion
        );
        assert_eq!(p(&["-V"]).unwrap_err().kind(), ErrorKind::DisplayVersion);
        assert_eq!(p(&["--help"]).unwrap_err().kind(), ErrorKind::DisplayHelp);
        assert_eq!(
            p(&["serve", "-h"]).unwrap_err().kind(),
            ErrorKind::DisplayHelp
        );
        let help = Cli::command().render_long_help().to_string();
        for sub in ["serve", "connect", "stdio", "winuser", "session"] {
            assert!(help.contains(sub), "{help}");
        }
        assert!(p(&[]).is_err());
    }
}
