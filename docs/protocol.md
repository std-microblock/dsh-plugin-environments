# dsh environment protocol (v1)

The wire protocol between the DSH host plugin (client) and `dsh-env-server` (server). One logical connection runs over any reliable byte stream: TCP, the server's stdin/stdout (`--stdio`), or an SSH exec channel.

## Framing

Every frame is:

```
u32 BE  frameLen      // bytes that follow (headerLen field + header + payload)
u32 BE  headerLen     // bytes of UTF-8 JSON header
[headerLen] JSON header (object, always has string field "t")
[frameLen - 4 - headerLen] binary payload (may be empty)
```

Maximum frame length: 16 MiB + 64 KiB. Payload chunks for streams are at most 256 KiB.

## Handshake

The client sends first:

```json
{ "t": "hello", "v": 1, "token": "<secret or empty>", "client": "dsh-plugin-environments/0.1.0" }
```

The server replies with either `{"t":"hello","v":1,"ok":true,"info":Info}` or `{"t":"hello","v":1,"ok":false,"error":{"code":"AUTH","message":"..."}}` and closes. A server started with `--token` rejects mismatched tokens (constant-time compare). A server started without a token (stdio mode) accepts any token.

```ts
interface Info {
  version: string // server version
  os: 'windows' | 'linux' | 'macos' | 'android' | string
  family: 'windows' | 'posix'
  arch: string // x86_64, aarch64, ...
  hostname: string
  user: string
  home: string // absolute
  cwd: string // server process cwd, absolute
  pathSep: '\\' | '/'
  shell: string // default shell executable (pwsh/powershell/cmd on windows, $SHELL or /bin/sh on posix)
  caps: string[] // e.g. ["fs","glob","grep","proc","pty","tcp","tcp-listen","udp","udp-listen","screenshot","input"]
}
```

## Requests

```json
{"t":"req","id":7,"op":"fs.stat","args":{...}}           // + optional payload
{"t":"res","id":7,"ok":true,"result":{...}}              // + optional payload
{"t":"res","id":7,"ok":false,"error":{"code":"ENOENT","message":"..."}}
{"t":"cancel","id":7}                                    // best effort; server replies res with code "CANCELLED" if it stopped
```

`id` is a client-chosen unsigned integer, unique among in-flight requests. Requests run concurrently on the server; responses may arrive in any order.

Error codes: `ENOENT`, `EEXIST`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY`, `EACCES`, `EINVAL`, `ETOOBIG`, `EIO`, `CANCELLED`, `UNSUPPORTED`, `AUTH`, `PROTOCOL`.

All paths are absolute paths in the server's own spelling, or relative to `args.cwd` when an op accepts `cwd`, else relative to the server cwd.

### Filesystem

| op               | args                                                                                                                                                                                  | result / payload                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fs.stat`        | `{path, follow?: boolean = true}`                                                                                                                                                     | `Stat \| null` (null = absent)                                                                                                                                          |
| `fs.readdir`     | `{path}`                                                                                                                                                                              | `{entries: DirEntry[]}` sorted by name                                                                                                                                  |
| `fs.read`        | `{path, offset?: number = 0, length?: number, max?: number}`                                                                                                                          | result `{size, eof}`; payload = bytes. If `length` is omitted the whole file is read; if the file (or the requested window) exceeds `max` (default 16 MiB) → `ETOOBIG`. |
| `fs.write`       | `{path, mode: 'overwrite' \| 'create' \| 'append', atomic?: boolean = true, mkdirs?: boolean = false}` + payload                                                                      | `Stat`. `create` fails with `EEXIST` if present. `atomic` writes a temp sibling then renames (ignored for `append`).                                                    |
| `fs.mkdir`       | `{path, recursive?: boolean}`                                                                                                                                                         | `{}`                                                                                                                                                                    |
| `fs.remove`      | `{path, recursive?: boolean}`                                                                                                                                                         | `{}`; removing a missing path → `ENOENT`                                                                                                                                |
| `fs.rename`      | `{from, to, overwrite?: boolean = false}`                                                                                                                                             | `{}`                                                                                                                                                                    |
| `fs.copy`        | `{from, to, recursive?: boolean, overwrite?: boolean}`                                                                                                                                | `{}` (server-local copy)                                                                                                                                                |
| `fs.realpath`    | `{path}`                                                                                                                                                                              | `{path}`                                                                                                                                                                |
| `fs.glob`        | `{pattern, cwd, limit?: number = 1000, hidden?: boolean = false, gitignore?: boolean = true}`                                                                                         | `{paths: string[], truncated: boolean}`; paths relative to `cwd` using `/`, sorted by mtime desc then name                                                              |
| `fs.grep`        | `{pattern, cwd, path?, glob?, literal?: boolean, ignoreCase?: boolean, multiline?: boolean, limit?: number = 500, filesOnly?: boolean, hidden?: boolean, gitignore?: boolean = true}` | `{matches: {path, line, text}[], files: string[], truncated: boolean}`; `path` relative to `cwd` with `/`; text is trimmed to 500 chars                                 |
| `fs.readStream`  | `{path}`                                                                                                                                                                              | `{ch, size}`; then server sends `data` frames on `ch` and finally `eof` + `close`                                                                                       |
| `fs.writeStream` | `{path, atomic?: boolean = true, mkdirs?: boolean}`                                                                                                                                   | `{ch}`; client sends `data` frames then `eof`; server answers with `close {ch, result: Stat}` or `close {ch, error}`                                                    |

```ts
interface Stat {
  type: 'file' | 'dir' | 'symlink' | 'other'
  size: number
  mtimeMs: number
  mode: number
  ino?: string
  dev?: string
}
interface DirEntry {
  name: string
  type: 'file' | 'dir' | 'symlink' | 'other'
  size?: number
  mtimeMs?: number
}
```

### Processes

| op            | args                                                                                                                                                           | result                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `proc.spawn`  | `{argv?: string[], command?: string, cwd?, env?: Record<string,string \| null>, clearEnv?: boolean, pty?: {rows, cols}, encoding?: 'utf8' \| 'auto' \| 'raw'}` | `{ch, pid}`                                              |
| `proc.resize` | `{ch, rows, cols}`                                                                                                                                             | `{}`                                                     |
| `proc.kill`   | `{ch, signal?: 'TERM' \| 'KILL' \| 'INT'}`                                                                                                                     | `{}` (kills the whole process tree; Windows: job object) |

Exactly one of `argv` / `command` is required. `command` runs through the platform shell (`$SHELL -c` or `/bin/sh -c` on posix; on windows `pwsh.exe` when it is on PATH, else `powershell.exe`, with `-NoLogo -NoProfile -NonInteractive -Command`). `env` entries with `null` remove a variable. Arguments, `cwd` and `env` are passed as UTF-16 (`CreateProcessW`), so non-ASCII values reach the child intact.

`encoding` only matters for pipe output on Windows servers (it is ignored on posix and for PTYs: ConPTY always emits UTF-8 and translates the child's code page itself, so terminals keep the console's default code page and localized messages):

- `utf8` (default): the child runs on a UTF-8 console. The server starts it through a copy of itself (`dsh-env-server __utf8-console -- <argv>`, which calls `SetConsoleCP`/`SetConsoleOutputCP(65001)` on its windowless console, runs the program there in a nested kill-on-close job and exits with its code), so the reported `pid` is that wrapper's. For `command`, Windows PowerShell's `$OutputEncoding` is also set to UTF-8 (a first script line, so error positions of the caller's code start at line 2). Output that still is not UTF-8 is transcoded as in `auto`. A missing program fails the spawn with `ENOENT` as before. Note that console tools such as `ping`, `net` or Windows PowerShell print their messages in English on a UTF-8 console.
- `auto`: the console keeps its code page (the OEM code page, e.g. 936). Output is decoded line by line: a line that is valid UTF-8 passes through, anything else is decoded with the OEM code page (`MultiByteToWideChar`) and sent as UTF-8; characters split across reads are held back until complete. Text the code page cannot represent (emoji, Korean on a Chinese system, ...) is already lost in the child (`?`).
- `raw`: the bytes are forwarded untouched (binary output). Both other modes also drop a leading UTF-8 BOM.

Channel data: stdin is client→server `data {ch, fd: 0}` and `eof {ch, fd: 0}`. Server sends `data {ch, fd: 1}` / `data {ch, fd: 2}` (PTY merges into fd 1), `eof {ch, fd}` when each output ends, `exit {ch, code, signal}` when the process exits, then `close {ch}` after all output is flushed.

### Network tunnels

| op             | args                                  | result                                                                                                                                                                                  |
| -------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `net.connect`  | `{host, port, proto: 'tcp' \| 'udp'}` | `{ch}` – the server connected (tcp) or bound an ephemeral socket "connected" to the target (udp). Bytes on `ch` are the TCP stream; for udp every `data` frame is exactly one datagram. |
| `net.listen`   | `{host, port, proto: 'tcp' \| 'udp'}` | `{id, port}` – actual bound port (port 0 = ephemeral).                                                                                                                                  |
| `net.unlisten` | `{id}`                                | `{}` – also closes channels accepted by it                                                                                                                                              |

For a tcp listener the server sends `{"t":"accept","listener":id,"ch":N,"peer":"ip:port"}` for each accepted connection; the channel then behaves like a `net.connect` channel. For a udp listener the server allocates one channel per distinct peer address (with an `accept` frame the first time) and every datagram from that peer becomes a `data` frame; datagrams the client writes on that channel are sent back to that peer. Idle udp peer channels close after 120 s.

### System

| op               | args                                                    | result                                                                                  |
| ---------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `sys.info`       | `{}`                                                    | `Info`                                                                                  |
| `sys.screenshot` | `ScreenshotArgs`                                        | `ScreenshotResult`; payload = PNG bytes (cap `screenshot`)                              |
| `sys.input`      | `{actions: InputAction[]}`                              | `{}` (cap `input`)                                                                      |
| `sys.displays`   | `{}`                                                    | `{displays: DisplayInfo[], virtual: PixelRect}` (cap `displays`)                        |
| `sys.windows`    | `{all?: boolean = false}`                               | `{windows: WindowInfo[], foreground: number}` in z-order, topmost first (cap `windows`) |
| `sys.window`     | `{hwnd, action: WindowAction, x?, y?, width?, height?}` | `WindowActionResult` (cap `windows`); `move` needs all four of x, y, width, height      |

Capabilities: `screenshot` and `input` (currently Windows servers), `displays` (`sys.displays` and `display` selection), `windows` (`sys.windows`, `sys.window`, `window` captures), `uia` (the host has Windows PowerShell, so clients can run UI Automation queries through `proc.spawn`; there is no `sys.uia` op). Android devices are driven by the plugin over adb and advertise `screenshot`, `input` and `android`.

All coordinates are **physical pixels of the virtual desktop** (the server is per-monitor DPI aware, v2), so the primary monitor's top-left is (0,0) and other monitors may have negative coordinates. Clients that downscale screenshots for a model map coordinates back before sending input.

```ts
interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

interface ScreenshotArgs {
  display?: number // index from sys.displays (0 = primary, default); -1 = whole virtual desktop
  rect?: PixelRect // capture this rectangle of the virtual desktop instead (clipped to it)
  window?: number // capture one top-level window by hwnd (PrintWindow: works when covered, not minimized)
  maxWidth?: number // downscale (area filter, never enlarges) to fit these bounds
  maxHeight?: number
  cursor?: boolean // draw the mouse pointer into the image
}

interface ScreenshotResult {
  width: number // image size
  height: number
  format: 'png'
  x?: number // physical rectangle the image covers (absent on old servers: primary screen at 0,0)
  y?: number
  srcWidth?: number
  srcHeight?: number
  cursor?: { x: number; y: number } // pointer position, physical, when cursor was requested
}

interface DisplayInfo extends PixelRect {
  index: number
  name: string
  primary: boolean
  dpi: number
  scale: number // dpi / 96
}

interface WindowInfo extends PixelRect {
  hwnd: number
  title: string
  class: string
  pid: number
  process: string // executable name
  visible: boolean
  minimized: boolean
  maximized: boolean
  foreground: boolean
  topmost: boolean
}

type WindowAction = 'focus' | 'minimize' | 'maximize' | 'restore' | 'close' | 'move'
// close posts WM_CLOSE (like clicking X). focus restores minimized windows first.

interface WindowActionResult {
  ok: boolean
  foreground: boolean // the window is the foreground window afterwards
  minimized: boolean
  rect: PixelRect | null
}

type MouseButton = 'left' | 'right' | 'middle' | 'back' | 'forward'

type InputAction =
  | { kind: 'move'; x: number; y: number }
  | {
      kind: 'click'
      x?: number
      y?: number
      button?: MouseButton
      double?: boolean
      count?: number
      modifiers?: string
    }
  | { kind: 'mouse_down' | 'mouse_up'; x?: number; y?: number; button?: MouseButton }
  | { kind: 'drag'; path: [number, number][]; button?: MouseButton; durationMs?: number; modifiers?: string }
  | { kind: 'scroll'; x?: number; y?: number; dx?: number; dy?: number; modifiers?: string }
  | { kind: 'type'; text: string; delayMs?: number }
  | { kind: 'key'; key: string; repeat?: number; holdMs?: number } // e.g. "enter", "ctrl+c", "alt+f4", "ctrl++"
  | { kind: 'key_down' | 'key_up'; key: string }
  | { kind: 'wait'; ms: number }
```

Input semantics:

- A batch runs in order on one thread. Keys and buttons still held when the batch ends (or fails) are released, so nothing stays stuck.
- `click`: `count` 1–3 (`double: true` = 2); without x/y it clicks at the current pointer position. `modifiers` (e.g. `"ctrl+shift"`) are held around the click, drag or scroll.
- `drag`: press at the first point, move through the others (interpolated over `durationMs`, default 400), release at the last; `x, y, x2, y2` is accepted instead of `path`.
- `scroll`: `dy`/`dx` in wheel notches (fractions allowed); positive `dy` scrolls down, positive `dx` right. With x/y the pointer moves there first.
- `type`: any Unicode text via `KEYEVENTF_UNICODE` (surrogate pairs included); `\n` / `\r\n` press Enter and `\t` presses Tab. `delayMs` pauses between characters.
- `key`: `+`-separated combo, case-insensitive names (`ctrl`, `shift`, `alt`, `win`, `enter`, `esc`, `tab`, `backspace`, `delete`, `home`, `end`, `pageup`, `pagedown`, arrows, `f1`–`f24`, `space`, media/volume keys, letters, digits, and layout-dependent single characters such as `;`). `repeat` presses it up to 100 times; `holdMs` keeps it down.
- `wait` and all durations are capped at 60 s.

## Channels and flow control

Channel ids (`ch`) are allocated by whoever opens the channel: the server allocates them for `proc.spawn`, `fs.readStream`, `fs.writeStream`, `net.connect` and accepted connections. All channel frames:

```json
{"t":"data","ch":3,"fd":1}        // + payload
{"t":"eof","ch":3,"fd":1}
{"t":"win","ch":3,"fd":1,"n":262144}   // receiver grants n more bytes
{"t":"exit","ch":3,"code":0,"signal":null}
{"t":"close","ch":3,"error":{...}?,"result":{...}?}
```

`fd` defaults to `0` for client→server data and `1` for server→client data when omitted (network and file channels omit it).

Each direction of each (ch, fd) has a send window that starts at 1 MiB. A sender must not send more payload bytes than the window allows; the receiver sends `win` after it consumed data (for example after writing to the socket / delivering to the application). Either side may send `close` to abort a channel; after `close` no more frames for that channel are valid.

## Keepalive

Either side may send `{"t":"ping","n":k}`; the peer answers `{"t":"pong","n":k}`. The client pings every 15 s; a server in TCP mode drops a connection that is silent for 60 s. When a connection ends, the server kills every process it spawned for it, closes its listeners and sockets and deletes unfinished atomic-write temp files.
