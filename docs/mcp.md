# MCP server (`dsh-env-mcp`)

`packages/plugin/dist/mcp.js` is the same environment stack as an MCP (Model Context Protocol)
server. An MCP client — Antigravity, Claude Code, Codex, Gemini CLI, anything that speaks MCP —
can borrow the devices and machines configured in the plugin and use them through tools, without
DeepSeek Harness being involved in the conversation.

It is a **stdio** server: the client spawns `node dist/mcp.js` and speaks newline-delimited
JSON-RPC 2.0 over the process's stdin/stdout. Everything the server logs goes to stderr.

```
MCP client ──stdio──> node dist/mcp.js
                          ├─ reads <dataDir>/environments.json (the definitions the GUI wrote)
                          ├─ local      → dsh-env-server child process
                          ├─ server     → TCP/WebSocket + secure channel
                          ├─ ssh        → ssh2, dsh-env-server staged on the host
                          ├─ adb        → adb CLI
                          ├─ winuser    → a dsh-managed Windows account
                          └─ reverse    → `dsh-env-server connect` from the target
```

## Configuring a client

The server is one stdio entry in the client's MCP configuration. `command` must be a Node.js
executable (the bundle ships no launcher) and `args` the absolute path of `dist/mcp.js`:

```json
{
  "mcpServers": {
    "environments": {
      "command": "node",
      "args": ["D:/dsh/dsh-plugin-environments/packages/plugin/dist/mcp.js"],
      "env": {
        "DSH_ENV_MCP_WORKSPACE": "D:/work/my-project"
      }
    }
  }
}
```

The published package also exposes the `dsh-env-mcp` bin script (`dist/mcp.js`), so an install
under `node_modules` can be launched through it.

### Antigravity

Antigravity keeps its servers in `~/.gemini/config/mcp_config.json` (global, all sessions) or in
`<plugin>/mcp_config.json` for a plugin. Add the entry above to `mcpServers`, then restart
Antigravity (or reload its window); **Additional Options (…) → MCP Servers** lists the server and
its tools once it connected. Antigravity also honours the entry's `cwd` (the server's working
directory is the default transfer workspace) and `disabled`; a per-project workspace can be given
with `cwd` or with `env: { "DSH_ENV_MCP_WORKSPACE": "<folder>" }`, since one global config cannot
know the folder of each project:

```json
{
  "mcpServers": {
    "environments": {
      "command": "C:/nvm4w/nodejs/node.exe",
      "args": ["D:/dsh/dsh-plugin-environments/packages/plugin/dist/mcp.js"],
      "cwd": "D:/work/my-project",
      "env": { "DSH_ENV_MCP_NAME": "Antigravity" }
    }
  }
}
```

### Options

| Flag                  | Environment variable    | Default                           | Meaning                                                       |
| --------------------- | ----------------------- | --------------------------------- | ------------------------------------------------------------- |
| `--data-dir <dir>`    | `DSH_ENV_MCP_DATA_DIR`  | `$DSH_HOME/storages/environments` | Where `environments.json` lives (the plugin's data directory) |
| `--workspace <dir>`   | `DSH_ENV_MCP_WORKSPACE` | the process's current directory   | Directory plain transfer paths are relative to                |
| `--adb <path>`        | `DSH_ENV_ADB`           | `adb` on `PATH`                   | adb executable used for Android environments                  |
| `--no-adb-discovery`  | —                       | discovery on                      | Do not list the devices of `adb devices`                      |
| `--allow <id,id>`     | `DSH_ENV_MCP_ALLOW`     | every borrowable environment      | Restrict what this server may borrow (repeatable)             |
| `--name <title>`      | `DSH_ENV_MCP_NAME`      | `MCP: <client> (pid N)`           | Name shown in the DSH lease list                              |
| `--version`, `--help` | —                       | —                                 | Print and exit                                                |

The definitions are read at startup; restart the server after adding or editing an environment in
DeepSeek Harness. `dsh-env-server` binaries are resolved exactly like for the plugin
(`packages/plugin/bin/<platform>-<arch>/`, or `DSH_ENV_SERVER_BIN`).

## Tools

The borrowing tools manage leases; the `env_*` tools are **the same definitions the plugin
registers with DSH**, so their behaviour cannot drift from what a DSH session gets.

| Tool                                                      | Required arguments      | Purpose                                                          |
| --------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------- |
| `env_list`                                                | —                       | Borrowable environments, live status, what this connection holds |
| `env_borrow`                                              | `environment`           | Borrow (optionally `gui: true`, `wait`, `timeout_seconds`)       |
| `env_return`                                              | `environment` (`all`)   | Return a lease, or only its GUI (`gui_only`)                     |
| `env_transfer`                                            | `source`, `destination` | Copy between the workspace and borrowed environments             |
| `env_exec`                                                | `command`               | Run a command to completion                                      |
| `env_read_file`, `env_read_image`                         | `path`                  | Read text (numbered lines) or a PNG/JPEG/WebP/GIF image          |
| `env_write_file`, `env_edit_file`                         | `path`, …               | Create/overwrite a file, replace literal text                    |
| `env_list_dir`, `env_glob`, `env_grep`                    | —, `pattern`, `pattern` | Directory listing, file and content search                       |
| `env_process_start`, `env_process_io`, `env_process_kill` | `command`, `id`, `id`   | Long-running or interactive programs (with `pty`)                |
| `env_tunnel`                                              | `action`                | TCP/UDP tunnels in both directions                               |
| `env_screenshot`, `env_input`, `env_ui`, `env_windows`    | —, `actions`, —, —      | GUI leases only: screenshot, pointer/keyboard, UI tree, windows  |
| `env_device`                                              | —                       | GUI leases only, Android: device state and controls              |
| `env_app`, `env_install_apk`, `env_logcat`                | `action`, `apk_path`, — | Android: manage apps, install an APK, read logs                  |

Every tool takes an optional `environment` argument: the alias `env_borrow` returned. It may be
omitted while only one borrowed environment offers that tool. Images come back as MCP `image`
content blocks (base64 PNG/JPEG), so a client shows them without a file step.

## Leases

Borrowing works exactly like in DSH, and it is the same environment, not a copy:

- a lease is headless by default (files, commands, processes, tunnels, Android app tools) and
  takes the GUI only with `gui: true`; at most one lease of an environment holds its GUI, and
  queues (`wait: true`) are FIFO;
- environments with "headless leases may run in parallel" off (exclusive) admit one lease at a
  time;
- every lease appears in the DSH **Environments** panel, titled `MCP: <client> (pid N)`, where a
  human can release it;
- a lease whose connection drops stays held and reconnects with growing delays (1 s … 30 s);
  calls wait up to 20 s for it instead of failing;
- returning an environment closes every process and tunnel opened through it. Closing the
  connection (stdin EOF) releases everything this server held.

The plugin and the MCP server are separate processes with separate lease tables: an environment
that DSH holds exclusively makes the MCP server queue, and vice versa, but two MCP server
processes only see each other through that admission.

## Testing

```sh
node --test packages/plugin/test/mcp.test.ts     # schema projection, validation, stdio session
node packages/plugin/dist/mcp.js --version        # the bundle itself
```

A raw session, for debugging:

```jsonc
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"hand","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"env_list","arguments":{}}}
```

## Limitations

- No mounts: the MCP server does not route a client's own file and shell tools into an
  environment, so everything goes through the `env_*` tools (or `env_transfer`).
- No prompt context: unlike a DSH session, an MCP client is not reminded about newly available
  environments; `env_list` is the source of truth.
- The client's own workspace is not known to the server; pass `--workspace` (or
  `DSH_ENV_MCP_WORKSPACE`) so `env_transfer` and `env_install_apk` can read from it.
- Screenshots, input, windows and UI automation still depend on what the environment supports
  (Windows dsh-env-server targets and Android; not Linux/macOS server targets).
- Cancellation (`notifications/cancelled`) aborts the waiting call, but a tool body that is
  already running on an environment finishes on its side.
