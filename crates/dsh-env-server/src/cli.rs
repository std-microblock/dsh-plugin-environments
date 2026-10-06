//! Minimal command-line parsing (replaces clap; same flags and subcommands).

use std::path::PathBuf;

pub const USAGE: &str = "\
Remote environment server for the DeepSeek Harness environments plugin

Usage: dsh-env-server <COMMAND>

Commands:
  serve    Serve the environment protocol over TCP
             --listen <ADDR>      Address to listen on [default: 127.0.0.1:7461]
             --token <TOKEN>      Shared secret clients must present
             --token-file <PATH>  Read the shared secret from a file
             --cwd <PATH>         Working directory for relative paths (`~` = home)
             --once               Exit after the first connection ends
  stdio    Serve exactly one session on stdin/stdout
             --cwd <PATH>
  winuser  Manage dsh-managed local Windows accounts
             create --name <N> --secret-out <PATH>
             delete --name <N> [--purge-profile]
             list
             launch --name <N> --secret-file <PATH> [--cwd <PATH>] [--supervise] -- <PROGRAM>...
             grant  --name <N> --path <PATH>

Options:
  -h, --help     Print help
  -V, --version  Print version
";

#[derive(Debug, PartialEq)]
pub enum WinUserCmd {
    Create {
        name: String,
        secret_out: String,
    },
    Delete {
        name: String,
        purge_profile: bool,
    },
    List,
    Launch {
        name: String,
        secret_file: String,
        cwd: Option<String>,
        program: Vec<String>,
        /// Stay alive, holding the process in a kill-on-close job, until it exits or
        /// stdin closes.
        supervise: bool,
    },
    Grant {
        name: String,
        path: String,
    },
}

#[derive(Debug, PartialEq)]
pub enum Cmd {
    Serve {
        listen: String,
        token: Option<String>,
        token_file: Option<PathBuf>,
        cwd: Option<PathBuf>,
        once: bool,
    },
    Stdio {
        cwd: Option<PathBuf>,
    },
    Winuser(WinUserCmd),
    Help,
    Version,
}

/// Parsed `--key value` / `--key=value` / `--flag` options plus trailing args after `--`.
struct Opts {
    pairs: Vec<(String, Option<String>)>,
    rest: Vec<String>,
    saw_dashdash: bool,
}

impl Opts {
    fn parse(args: &[String], flags: &[&str], values: &[&str]) -> Result<Opts, String> {
        let mut pairs = Vec::new();
        let mut i = 0;
        while i < args.len() {
            let a = &args[i];
            if a == "--" {
                return Ok(Opts {
                    pairs,
                    rest: args[i + 1..].to_vec(),
                    saw_dashdash: true,
                });
            }
            if a == "-h" || a == "--help" {
                pairs.push(("help".into(), None));
                i += 1;
                continue;
            }
            let Some(body) = a.strip_prefix("--") else {
                return Err(format!("unexpected argument '{a}'"));
            };
            let (key, inline) = match body.split_once('=') {
                Some((k, v)) => (k, Some(v.to_string())),
                None => (body, None),
            };
            if flags.contains(&key) {
                if inline.is_some() {
                    return Err(format!("unexpected value for '--{key}'"));
                }
                pairs.push((key.to_string(), None));
            } else if values.contains(&key) {
                let v = match inline {
                    Some(v) => v,
                    None => {
                        i += 1;
                        args.get(i)
                            .cloned()
                            .ok_or_else(|| format!("a value is required for '--{key} <VALUE>'"))?
                    }
                };
                if pairs.iter().any(|(k, _)| k == key) {
                    return Err(format!(
                        "the argument '--{key}' cannot be used multiple times"
                    ));
                }
                pairs.push((key.to_string(), Some(v)));
            } else {
                return Err(format!("unexpected argument '--{key}'"));
            }
            i += 1;
        }
        Ok(Opts {
            pairs,
            rest: Vec::new(),
            saw_dashdash: false,
        })
    }
    fn has(&self, k: &str) -> bool {
        self.pairs.iter().any(|(key, _)| key == k)
    }
    fn get(&self, k: &str) -> Option<String> {
        self.pairs
            .iter()
            .find(|(key, _)| key == k)
            .and_then(|(_, v)| v.clone())
    }
    fn req(&self, k: &str) -> Result<String, String> {
        self.get(k).ok_or_else(|| {
            format!("the following required arguments were not provided: --{k} <VALUE>")
        })
    }
}

pub fn parse(args: &[String]) -> Result<Cmd, String> {
    let Some(sub) = args.first() else {
        return Err("missing command".into());
    };
    let rest = &args[1..];
    let no_rest = |o: &Opts| {
        if o.saw_dashdash && !o.rest.is_empty() {
            Err(format!("unexpected argument '{}'", o.rest[0]))
        } else {
            Ok(())
        }
    };
    match sub.as_str() {
        "-h" | "--help" | "help" => Ok(Cmd::Help),
        "-V" | "--version" => Ok(Cmd::Version),
        "serve" => {
            let o = Opts::parse(rest, &["once"], &["listen", "token", "token-file", "cwd"])?;
            no_rest(&o)?;
            if o.has("help") {
                return Ok(Cmd::Help);
            }
            Ok(Cmd::Serve {
                listen: o.get("listen").unwrap_or_else(|| "127.0.0.1:7461".into()),
                token: o.get("token"),
                token_file: o.get("token-file").map(PathBuf::from),
                cwd: o.get("cwd").map(PathBuf::from),
                once: o.has("once"),
            })
        }
        "stdio" => {
            let o = Opts::parse(rest, &[], &["cwd"])?;
            no_rest(&o)?;
            if o.has("help") {
                return Ok(Cmd::Help);
            }
            Ok(Cmd::Stdio {
                cwd: o.get("cwd").map(PathBuf::from),
            })
        }
        "winuser" => {
            let Some(op) = rest.first() else {
                return Err("missing winuser command".into());
            };
            let rest = &rest[1..];
            let cmd = match op.as_str() {
                "-h" | "--help" | "help" => return Ok(Cmd::Help),
                "create" => {
                    let o = Opts::parse(rest, &[], &["name", "secret-out"])?;
                    no_rest(&o)?;
                    if o.has("help") {
                        return Ok(Cmd::Help);
                    }
                    WinUserCmd::Create {
                        name: o.req("name")?,
                        secret_out: o.req("secret-out")?,
                    }
                }
                "delete" => {
                    let o = Opts::parse(rest, &["purge-profile"], &["name"])?;
                    no_rest(&o)?;
                    if o.has("help") {
                        return Ok(Cmd::Help);
                    }
                    WinUserCmd::Delete {
                        name: o.req("name")?,
                        purge_profile: o.has("purge-profile"),
                    }
                }
                "list" => {
                    let o = Opts::parse(rest, &[], &[])?;
                    no_rest(&o)?;
                    if o.has("help") {
                        return Ok(Cmd::Help);
                    }
                    WinUserCmd::List
                }
                "launch" => {
                    let o = Opts::parse(rest, &["supervise"], &["name", "secret-file", "cwd"])?;
                    if o.has("help") {
                        return Ok(Cmd::Help);
                    }
                    if o.rest.is_empty() {
                        return Err(
                            "the following required arguments were not provided: -- <PROGRAM>..."
                                .into(),
                        );
                    }
                    WinUserCmd::Launch {
                        name: o.req("name")?,
                        secret_file: o.req("secret-file")?,
                        cwd: o.get("cwd"),
                        supervise: o.has("supervise"),
                        program: o.rest,
                    }
                }
                "grant" => {
                    let o = Opts::parse(rest, &[], &["name", "path"])?;
                    no_rest(&o)?;
                    if o.has("help") {
                        return Ok(Cmd::Help);
                    }
                    WinUserCmd::Grant {
                        name: o.req("name")?,
                        path: o.req("path")?,
                    }
                }
                other => return Err(format!("unrecognized subcommand '{other}'")),
            };
            Ok(Cmd::Winuser(cmd))
        }
        other => Err(format!("unrecognized subcommand '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &[&str]) -> Result<Cmd, String> {
        parse(&s.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn serve_defaults_and_values() {
        assert_eq!(
            p(&["serve"]).unwrap(),
            Cmd::Serve {
                listen: "127.0.0.1:7461".into(),
                token: None,
                token_file: None,
                cwd: None,
                once: false
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
                token: Some("abc".into()),
                token_file: None,
                cwd: Some("/x".into()),
                once: true
            }
        );
        assert!(p(&["serve", "--bogus"]).is_err());
        assert!(p(&["serve", "--token"]).is_err());
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
                program: vec!["a.exe".into(), "--flag".into()],
                supervise: false,
            })
        );
        assert!(matches!(
            p(&[
                "winuser",
                "launch",
                "--name",
                "u",
                "--secret-file",
                "s",
                "--supervise",
                "--",
                "a"
            ]),
            Ok(Cmd::Winuser(WinUserCmd::Launch {
                supervise: true,
                ..
            }))
        ));
        assert!(p(&["winuser", "launch", "--name", "u", "--secret-file", "s"]).is_err());
        assert_eq!(
            p(&["winuser", "list"]).unwrap(),
            Cmd::Winuser(WinUserCmd::List)
        );
        assert!(p(&["winuser", "create", "--name", "u"]).is_err());
    }
}
