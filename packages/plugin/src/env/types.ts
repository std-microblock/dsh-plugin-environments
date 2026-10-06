// Shared vocabulary of the environment abstraction.
import type { Readable, Writable } from 'node:stream'
import type {
  ExitInfo,
  GlobResult,
  GrepArgs,
  GrepResult,
  InputAction,
  NetProto,
  SpawnArgs,
  Stat,
  WriteMode,
} from '@dsh-environments/protocol'

export type {
  Capability,
  DirEntry,
  ExitInfo,
  GlobResult,
  GrepResult,
  Info,
  NetProto,
  Stat,
} from '@dsh-environments/protocol'

/** Environment implementations. `host` is the harness's own filesystem (transfers only). */
export type EnvironmentKind = 'local' | 'server' | 'ssh' | 'adb' | 'winuser' | 'reverse' | 'host'

export interface SignalOptions {
  signal?: AbortSignal | undefined
}

export interface StatOptions extends SignalOptions {
  /** Follow a final symlink (default true). */
  follow?: boolean
}

export interface ReadFileOptions extends SignalOptions {
  offset?: number
  length?: number
  /** Fail with ETOOBIG instead of reading more than this many bytes. */
  maxBytes?: number
  /** Alias of `maxBytes`. */
  max?: number
}

export interface WriteFileOptions extends SignalOptions {
  mode?: WriteMode
  atomic?: boolean
  mkdirs?: boolean
}

export interface RecursiveOptions extends SignalOptions {
  recursive?: boolean
}

export interface RenameOptions extends SignalOptions {
  overwrite?: boolean
}

export interface CopyOptions extends SignalOptions {
  recursive?: boolean
  overwrite?: boolean
}

export interface GlobOptions extends SignalOptions {
  cwd?: string | undefined
  limit?: number
  hidden?: boolean
  gitignore?: boolean
}

export type GrepOptions = Omit<GrepArgs, 'pattern'> & SignalOptions

/** Results of glob/grep also report the directory they searched. */
export type GlobOutcome = GlobResult & { cwd?: string | undefined }
export type GrepOutcome = GrepResult & { cwd?: string | undefined }

/** What to run: an argv vector or a shell command line, plus cwd/env/pty. */
export type SpawnSpec = SpawnArgs

/** A process running in an environment. */
export interface EnvProcess {
  readonly pid: number | undefined
  readonly pty: boolean
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  /** Resolves when the process exits (or its channel is lost). */
  readonly exited: Promise<ExitInfo>
  write(data: Uint8Array | string): Promise<void>
  end(): void
  resize(rows: number, cols: number): Promise<void>
  kill(signal?: 'TERM' | 'KILL' | 'INT'): Promise<void>
}

export interface ExecOptions extends SignalOptions {
  stdin?: Uint8Array | string | undefined
  maxBytes?: number
  timeoutMs?: number
}

export interface ExecResult {
  code: number | null
  signal: string | null
  stdout: Buffer
  stderr: Buffer
  truncated: boolean
  timedOut: false | undefined
}

export interface ForwardOptions {
  localHost?: string
  localPort?: number
  remoteHost?: string
  remotePort: number
  proto?: NetProto
}

export interface ReverseOptions {
  remoteHost?: string
  remotePort?: number
  localHost?: string
  localPort: number
  proto?: NetProto
}

export interface TunnelSpec {
  kind: 'forward' | 'reverse'
  proto: NetProto
  localHost: string
  localPort: number
  remoteHost: string
  remotePort: number
}

/** Public description of an open tunnel. */
export interface TunnelInfo extends TunnelSpec {
  id: string
  createdAt: number
}

/** An open tunnel; `close()` is idempotent. */
export interface Tunnel extends TunnelInfo {
  close: () => Promise<void>
}

export interface Screenshot {
  png: Buffer
  width: number
  height: number
}

/**
 * Input actions accepted by environments: the protocol's actions plus the touch gestures
 * understood by Android (`tap`, `swipe`, long press).
 */
export type EnvInputAction =
  | InputAction
  | {
      kind: 'click' | 'tap'
      x?: number
      y?: number
      double?: boolean
      long?: boolean
      button?: 'left' | 'right' | 'middle'
    }
  | { kind: 'swipe'; x?: number; y?: number; x2?: number; y2?: number; durationMs?: number }

/** Every field any input action may carry; each {@link EnvInputAction} is assignable to it. */
export interface InputActionFields {
  kind: EnvInputAction['kind']
  x?: number
  y?: number
  x2?: number
  y2?: number
  dx?: number
  dy?: number
  button?: 'left' | 'right' | 'middle'
  double?: boolean
  long?: boolean
  durationMs?: number
  text?: string
  key?: string
  ms?: number
}

/** Streamed write handle returned by `openWrite`. */
export interface WriteHandle {
  stream: Writable
  done: Promise<Stat>
  writeAll(data: Buffer): Promise<Stat>
  abort(): void
}
