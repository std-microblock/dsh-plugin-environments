// Base class for every environment implementation.
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { EnvError, type Capability, type DirEntry, type Info, type Stat } from '@dsh-environments/protocol'
import type {
  Capture,
  CaptureOptions,
  CopyOptions,
  DisplayInfo,
  PixelRect,
  WindowAction,
  WindowActionResult,
  WindowInfo,
  InputActionFields,
  EnvironmentKind,
  EnvProcess,
  ExecOptions,
  ExecResult,
  ForwardOptions,
  GlobOptions,
  GlobOutcome,
  GrepOptions,
  GrepOutcome,
  ReadFileOptions,
  RecursiveOptions,
  RenameOptions,
  ReverseOptions,
  Screenshot,
  SignalOptions,
  SpawnSpec,
  StatOptions,
  Tunnel,
  TunnelInfo,
  TunnelSpec,
  WriteFileOptions,
} from './types.ts'

let tunnelSeq = 0

export interface EnvironmentOptions {
  id: string
  name?: string | undefined
  kind: EnvironmentKind
}

export interface EnvironmentEvents {
  change: []
  close: [Error | undefined]
}

/** Public snapshot of an environment. */
export interface EnvironmentDescription {
  id: string
  name: string
  kind: EnvironmentKind
  info: Info | undefined
  closed: boolean
  tunnels: TunnelInfo[]
}

/**
 * An environment is a device the harness can control: files, processes, tunnels and
 * (optionally) screen/input. Every operation defaults to throwing `UNSUPPORTED`;
 * implementations override what they support and advertise it through `info.caps`.
 *
 * Implementations: ServerEnvironment (dsh-env-server over TCP / stdio / SSH exec),
 * SshEnvironment (plain SFTP + exec), AdbEnvironment, HostEnvironment (transfers).
 */
export abstract class Environment extends EventEmitter<EnvironmentEvents> {
  readonly id: string
  readonly name: string
  readonly kind: EnvironmentKind
  info: Info | undefined = undefined
  closed = false
  closeError: Error | undefined = undefined
  readonly tunnels = new Map<string, Tunnel>()

  constructor({ id, name, kind }: EnvironmentOptions) {
    super()
    this.id = id
    this.name = name ?? id
    this.kind = kind
  }

  get caps(): Set<Capability> {
    return new Set(this.info?.caps ?? [])
  }

  hasCap(cap: Capability): boolean {
    return this.caps.has(cap)
  }

  get family(): 'windows' | 'posix' {
    return this.info?.family ?? 'posix'
  }

  /** Path module matching the environment's platform. */
  get path(): typeof path.posix {
    return this.family === 'windows' ? path.win32 : path.posix
  }

  /** Resolve a possibly relative path against cwd in the environment's spelling. */
  resolvePath(p: string, cwd?: string): string {
    const P = this.path
    if (P.isAbsolute(p)) return P.normalize(p)
    return P.resolve(cwd ?? this.info?.cwd ?? (this.family === 'windows' ? 'C:\\' : '/'), p)
  }

  /** Register an open tunnel so it is listed and closed together with the environment. */
  protected trackTunnel(spec: TunnelSpec & { close: () => Promise<void> }): Tunnel {
    const id = `t${++tunnelSeq}`
    const { close, ...rest } = spec
    const entry: Tunnel = {
      id,
      ...rest,
      createdAt: Date.now(),
      close: async () => {
        if (!this.tunnels.has(id)) return
        this.tunnels.delete(id)
        await close()
        this.emit('change')
      },
    }
    this.tunnels.set(id, entry)
    this.emit('change')
    return entry
  }

  listTunnels(): TunnelInfo[] {
    return [...this.tunnels.values()].map(({ close: _close, ...rest }) => rest)
  }

  /** Mark the environment closed (transport lost or closed). Idempotent. */
  markClosed(error?: Error): void {
    if (this.closed) return
    this.closed = true
    this.closeError = error
    for (const t of [...this.tunnels.values()]) t.close().catch(() => {})
    this.emit('close', error)
  }

  /** Close tunnels and the transport. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return
    for (const t of [...this.tunnels.values()]) await t.close().catch(() => {})
    try {
      await this.closeTransport()
    } finally {
      this.markClosed()
    }
  }

  /** Release the underlying transport (connection, child process, ...). */
  protected async closeTransport(): Promise<void> {}

  // ---- capability defaults -------------------------------------------------

  stat(_path: string, _opts?: StatOptions): Promise<Stat | null> {
    return this.unsupported('stat')
  }
  readdir(_path: string, _opts?: SignalOptions): Promise<DirEntry[]> {
    return this.unsupported('readdir')
  }
  readFile(_path: string, _opts?: ReadFileOptions): Promise<Buffer> {
    return this.unsupported('readFile')
  }
  writeFile(_path: string, _data: Uint8Array | string, _opts?: WriteFileOptions): Promise<Stat | null> {
    return this.unsupported('writeFile')
  }
  mkdir(_path: string, _opts?: RecursiveOptions): Promise<void> {
    return this.unsupported('mkdir')
  }
  remove(_path: string, _opts?: RecursiveOptions): Promise<void> {
    return this.unsupported('remove')
  }
  rename(_from: string, _to: string, _opts?: RenameOptions): Promise<void> {
    return this.unsupported('rename')
  }
  copy(_from: string, _to: string, _opts?: CopyOptions): Promise<void> {
    return this.unsupported('copy')
  }
  realpath(p: string, _opts?: SignalOptions): Promise<string> {
    return Promise.resolve(p)
  }
  glob(_pattern: string, _opts?: GlobOptions): Promise<GlobOutcome> {
    return this.unsupported('glob')
  }
  grep(_pattern: string, _opts?: GrepOptions): Promise<GrepOutcome> {
    return this.unsupported('grep')
  }
  spawn(_spec: SpawnSpec, _opts?: SignalOptions): Promise<EnvProcess> {
    return this.unsupported('spawn')
  }
  forward(_opts: ForwardOptions): Promise<Tunnel> {
    return this.unsupported('forward')
  }
  reverse(_opts: ReverseOptions): Promise<Tunnel> {
    return this.unsupported('reverse')
  }
  screenshot(_opts?: SignalOptions): Promise<Screenshot> {
    return this.unsupported('screenshot')
  }
  input(_actions: readonly InputActionFields[], _opts?: SignalOptions): Promise<void> {
    return this.unsupported('input')
  }
  /**
   * Capture the screen (or part of it) for computer use. The default takes a full
   * {@link screenshot}; implementations may honour `opts` and return a smaller area.
   */
  async capture(opts: CaptureOptions = {}): Promise<Capture> {
    const s = await this.screenshot(opts)
    return { png: s.png, width: s.width, height: s.height, rect: { x: 0, y: 0, width: s.width, height: s.height } }
  }
  /** Attached displays (physical pixels). */
  displays(_opts?: SignalOptions): Promise<DisplayInfo[]> {
    return this.unsupported('displays')
  }
  /** Top-level windows in z-order (topmost first). */
  windows(_opts?: SignalOptions & { all?: boolean }): Promise<WindowInfo[]> {
    return this.unsupported('windows')
  }
  /** Focus, minimize, maximize, restore, close or move (`rect`, physical pixels) a window. */
  windowAction(
    _hwnd: number,
    _action: WindowAction,
    _rect?: PixelRect,
    _opts?: SignalOptions,
  ): Promise<WindowActionResult> {
    return this.unsupported('windowAction')
  }

  private unsupported(op: string): Promise<never> {
    return Promise.reject(unsupported(this, op))
  }

  /** Run a command to completion and collect output (convenience). */
  async exec(
    spec: SpawnSpec,
    { signal, stdin, maxBytes = 4 * 1024 * 1024, timeoutMs }: ExecOptions = {},
  ): Promise<ExecResult> {
    const proc = await this.spawn(spec, { signal })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outLen = 0
    let errLen = 0
    let truncated = false
    proc.stdout.on('data', (d: Buffer) => {
      if (outLen < maxBytes) {
        out.push(d)
        outLen += d.length
      } else truncated = true
    })
    proc.stderr.on('data', (d: Buffer) => {
      if (errLen < maxBytes) {
        err.push(d)
        errLen += d.length
      } else truncated = true
    })
    const onAbort = () => {
      proc.kill().catch(() => {})
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = timeoutMs ? setTimeout(onAbort, timeoutMs) : undefined
    try {
      if (stdin !== undefined) await proc.write(Buffer.isBuffer(stdin) ? stdin : Buffer.from(stdin))
      proc.end()
      const exit = await proc.exited
      const ended = (s: NodeJS.ReadableStream & { readableEnded?: boolean }) =>
        s.readableEnded
          ? undefined
          : new Promise<void>(r => {
              s.once('end', r)
              s.once('close', r)
              setTimeout(r, 2000)
            })
      await Promise.all([ended(proc.stdout), ended(proc.stderr)])
      return {
        code: exit.code,
        signal: exit.signal,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        truncated,
        timedOut: signal?.aborted ? false : undefined,
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  describe(): EnvironmentDescription {
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      info: this.info,
      closed: this.closed,
      tunnels: this.listTunnels(),
    }
  }
}

/** The error every unsupported operation raises. */
export function unsupported(env: { name?: string; kind: string }, op: string): EnvError {
  return new EnvError('UNSUPPORTED', `${env.name ?? 'environment'} (${env.kind}) does not support ${op}`)
}
