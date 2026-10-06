// Message vocabulary of the dsh environment protocol (docs/protocol.md).

/** Protocol version sent in the handshake. */
export const PROTOCOL_VERSION = 2

/** Client identification sent in the handshake. */
export const CLIENT_ID = 'dsh-plugin-environments/0.2.0'

/** Initial per-direction send window of every (channel, fd), in bytes. */
export const WINDOW = 1024 * 1024
/** Maximum payload of one stream `data` frame, in bytes. */
export const CHUNK = 256 * 1024
/** Maximum frame length (16 MiB + 64 KiB). */
export const MAX_FRAME = 16 * 1024 * 1024 + 64 * 1024

/** Error codes defined by the protocol, plus the client-side codes used by this implementation. */
export type ProtocolErrorCode =
  | 'ENOENT'
  | 'EEXIST'
  | 'ENOTDIR'
  | 'EISDIR'
  | 'ENOTEMPTY'
  | 'EACCES'
  | 'EINVAL'
  | 'ETOOBIG'
  | 'EIO'
  | 'CANCELLED'
  | 'UNSUPPORTED'
  | 'AUTH'
  | 'PROTOCOL'

/** Codes raised by the host side (connection state, leasing, timeouts). */
export type ClientErrorCode = 'CLOSED' | 'ETIMEDOUT' | 'EBUSY'

/** Any error code carried by an {@link EnvError}; unknown strings from peers are kept verbatim. */
export type ErrorCode = ProtocolErrorCode | ClientErrorCode | (string & {})

/** Error object as sent on the wire. */
export interface WireError {
  code: ErrorCode
  message: string
}

/** Operating-system family of an environment. */
export type OsFamily = 'windows' | 'posix'

/** Well-known capability names; servers may report others. */
export type KnownCapability =
  | 'fs'
  | 'glob'
  | 'grep'
  | 'proc'
  | 'pty'
  | 'tcp'
  | 'tcp-listen'
  | 'udp'
  | 'udp-listen'
  | 'screenshot'
  | 'input'
  | 'displays'
  | 'windows'
  | 'uia'
  | 'android'

export type Capability = KnownCapability | (string & {})

/** Server facts returned by the handshake and `sys.info`. */
export interface Info {
  version: string
  os: 'windows' | 'linux' | 'macos' | 'android' | (string & {})
  family: OsFamily
  arch: string
  hostname: string
  user: string
  home: string
  cwd: string
  pathSep: '\\' | '/' | (string & {})
  shell: string
  caps: Capability[]
}

export type FileType = 'file' | 'dir' | 'symlink' | 'other'

export interface Stat {
  type: FileType
  size: number
  mtimeMs: number
  mode: number
  ino?: string
  dev?: string
}

export interface DirEntry {
  name: string
  type: FileType
  size?: number
  mtimeMs?: number
}

export type WriteMode = 'overwrite' | 'create' | 'append'
export type NetProto = 'tcp' | 'udp'
export type KillSignal = 'TERM' | 'KILL' | 'INT'

export interface GlobArgs {
  pattern: string
  cwd?: string
  limit?: number
  hidden?: boolean
  gitignore?: boolean
}

export interface GlobResult {
  paths: string[]
  truncated: boolean
}

export interface GrepArgs {
  pattern: string
  cwd?: string
  path?: string
  glob?: string
  literal?: boolean
  ignoreCase?: boolean
  multiline?: boolean
  limit?: number
  filesOnly?: boolean
  hidden?: boolean
  gitignore?: boolean
}

export interface GrepMatch {
  path: string
  line: number
  text: string
}

export interface GrepResult {
  matches: GrepMatch[]
  files: string[]
  truncated: boolean
}

export interface PtySize {
  rows: number
  cols: number
}

/** `proc.spawn` arguments. Exactly one of `argv` / `command` is required. */
export interface SpawnArgs {
  argv?: string[]
  command?: string
  cwd?: string
  env?: Record<string, string | null>
  clearEnv?: boolean
  pty?: PtySize
  /**
   * How a Windows server treats pipe output (ignored on posix and for PTYs, whose output is
   * always UTF-8): `utf8` (default) runs the child on a UTF-8 console and transcodes leftover
   * code-page text; `auto` keeps the console code page and transcodes code-page (e.g. GBK) lines
   * to UTF-8; `raw` forwards the bytes untouched (binary output). See docs/protocol.md.
   */
  encoding?: SpawnEncoding
}

/** See {@link SpawnArgs.encoding}. */
export type SpawnEncoding = 'utf8' | 'auto' | 'raw'

export type MouseButton = 'left' | 'right' | 'middle' | 'back' | 'forward'

/**
 * Pointer/keyboard action for `sys.input`. Coordinates are physical pixels of the virtual
 * desktop. `modifiers` is a combo such as `"ctrl+shift"` held during the action.
 */
export type InputAction =
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
  | {
      kind: 'drag'
      path: readonly (readonly [number, number])[]
      button?: MouseButton
      durationMs?: number
      modifiers?: string
    }
  | { kind: 'scroll'; x?: number; y?: number; dx?: number; dy?: number; modifiers?: string }
  | { kind: 'type'; text: string; delayMs?: number }
  | { kind: 'key'; key: string; repeat?: number; holdMs?: number }
  | { kind: 'key_down' | 'key_up'; key: string }
  | { kind: 'wait'; ms: number }

/** A rectangle in physical pixels. */
export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

/** `sys.screenshot` arguments (all optional; servers without cap `displays` only know `display`). */
export interface ScreenshotArgs {
  /** Display index from `sys.displays` (0 = primary); -1 = the whole virtual desktop. */
  display?: number
  /** Capture this rectangle of the virtual desktop instead. */
  rect?: PixelRect
  /** Capture this top-level window (hwnd from `sys.windows`). */
  window?: number
  /** Downscale (never enlarge) to fit these bounds. */
  maxWidth?: number
  maxHeight?: number
  /** Draw the mouse pointer into the image. */
  cursor?: boolean
}

export interface ScreenshotResult {
  width: number
  height: number
  format: 'png'
  /** Physical rectangle the image covers (absent on old servers: the primary screen at 0,0). */
  x?: number
  y?: number
  srcWidth?: number
  srcHeight?: number
  cursor?: { x: number; y: number }
}

export interface DisplayInfo extends PixelRect {
  index: number
  name: string
  primary: boolean
  dpi: number
  /** dpi / 96. */
  scale: number
}

export interface WindowInfo extends PixelRect {
  hwnd: number
  title: string
  class: string
  pid: number
  process: string
  visible: boolean
  minimized: boolean
  maximized: boolean
  foreground: boolean
  topmost: boolean
}

export type WindowAction = 'focus' | 'minimize' | 'maximize' | 'restore' | 'close' | 'move'

export interface WindowActionResult {
  ok: boolean
  foreground: boolean
  minimized: boolean
  rect: PixelRect | null
}

type Empty = Record<string, never>

/**
 * Every request op with its argument and result types. `EnvClient.request` / `call` are
 * typed against this map, so adding an op here is all that is needed to use it.
 */
export interface OpMap {
  'fs.stat': { args: { path: string; follow?: boolean }; result: Stat | null }
  'fs.readdir': { args: { path: string }; result: { entries: DirEntry[] } }
  'fs.read': {
    args: { path: string; offset?: number; length?: number; max?: number }
    result: { size: number; eof: boolean }
  }
  'fs.write': { args: { path: string; mode: WriteMode; atomic?: boolean; mkdirs?: boolean }; result: Stat }
  'fs.mkdir': { args: { path: string; recursive?: boolean }; result: Empty }
  'fs.remove': { args: { path: string; recursive?: boolean }; result: Empty }
  'fs.rename': { args: { from: string; to: string; overwrite?: boolean }; result: Empty }
  'fs.copy': { args: { from: string; to: string; recursive?: boolean; overwrite?: boolean }; result: Empty }
  'fs.realpath': { args: { path: string }; result: { path: string } }
  'fs.glob': { args: GlobArgs; result: GlobResult }
  'fs.grep': { args: GrepArgs; result: GrepResult }
  'fs.readStream': { args: { path: string }; result: { ch: number; size: number } }
  'fs.writeStream': { args: { path: string; atomic?: boolean; mkdirs?: boolean }; result: { ch: number } }
  'proc.spawn': { args: SpawnArgs; result: { ch: number; pid: number } }
  'proc.resize': { args: { ch: number; rows: number; cols: number }; result: Empty }
  'proc.kill': { args: { ch: number; signal?: KillSignal }; result: Empty }
  'net.connect': { args: { host: string; port: number; proto: NetProto }; result: { ch: number } }
  'net.listen': { args: { host: string; port: number; proto: NetProto }; result: { id: number; port: number } }
  'net.unlisten': { args: { id: number }; result: Empty }
  'sys.info': { args: Empty; result: Info }
  'sys.screenshot': { args: ScreenshotArgs; result: ScreenshotResult }
  'sys.input': { args: { actions: readonly InputAction[] }; result: Empty }
  'sys.displays': { args: Empty; result: { displays: DisplayInfo[]; virtual: PixelRect } }
  'sys.windows': { args: { all?: boolean }; result: { windows: WindowInfo[]; foreground: number } }
  'sys.window': {
    args: { hwnd: number; action: WindowAction; x?: number; y?: number; width?: number; height?: number }
    result: WindowActionResult
  }
}

export type Op = keyof OpMap
export type OpArgs<O extends Op> = OpMap[O]['args']
export type OpResult<O extends Op> = OpMap[O]['result']

/** Process exit facts carried by an `exit` frame. */
export interface ExitInfo {
  code: number | null
  signal: string | null
}

// ---- frame headers -----------------------------------------------------------

export interface HelloRequest {
  t: 'hello'
  v: number
  token: string
  client: string
}

export type HelloResponse =
  { t: 'hello'; v: number; ok: true; info: Partial<Info> } | { t: 'hello'; v: number; ok: false; error?: WireError }

export interface RequestHeader {
  t: 'req'
  id: number
  op: string
  args: unknown
}

export type ResponseHeader =
  { t: 'res'; id: number; ok: true; result: unknown } | { t: 'res'; id: number; ok: false; error?: WireError }

export interface CancelHeader {
  t: 'cancel'
  id: number
}

export interface PingHeader {
  t: 'ping' | 'pong'
  n: number
}

export interface AcceptHeader {
  t: 'accept'
  listener: number
  ch: number
  peer: string
}

export interface DataHeader {
  t: 'data'
  ch: number
  fd?: number
}

export interface EofHeader {
  t: 'eof'
  ch: number
  fd?: number
}

export interface WinHeader {
  t: 'win'
  ch: number
  fd?: number
  n?: number
}

export interface ExitHeader {
  t: 'exit'
  ch: number
  code?: number | null
  signal?: string | null
}

export interface CloseHeader {
  t: 'close'
  ch: number
  result?: unknown
  error?: WireError
}

export type ChannelHeader = DataHeader | EofHeader | WinHeader | ExitHeader | CloseHeader

/** Every frame header the client may receive. */
export type IncomingHeader = HelloResponse | ResponseHeader | PingHeader | AcceptHeader | ChannelHeader

/** Every frame header the client may send. */
export type OutgoingHeader = HelloRequest | RequestHeader | CancelHeader | PingHeader | ChannelHeader

/** Any decoded JSON header: an object with a string `t`. */
export interface FrameHeader {
  t: string
  [key: string]: unknown
}
