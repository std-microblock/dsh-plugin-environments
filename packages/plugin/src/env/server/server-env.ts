// Environment implementation backed by a dsh-env-server connection.
import { EnvClient, EnvError, type DirEntry, type Info, type Stat, type Transport } from '@dsh-environments/protocol'
import { Environment, type EnvironmentOptions } from '../environment.ts'
import type {
  CopyOptions,
  InputActionFields,
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
  WriteFileOptions,
  WriteHandle,
} from '../types.ts'
import { ServerProcess } from './server-process.ts'
import { forwardTcp, forwardUdp, reverseTunnel } from './tunnels.ts'
import type { Readable } from 'node:stream'
import type { InputAction } from '@dsh-environments/protocol'
import type { Client as SshClient } from 'ssh2'

/** Whole-file reads/writes above this size go through streams instead of single frames. */
const STREAM_THRESHOLD = 15 * 1024 * 1024
const MAX_READ = 16 * 1024 * 1024

export interface ServerEnvironmentOptions extends EnvironmentOptions {
  /** Duplex transport (net.Socket, SSH exec stream or childTransport()). */
  transport: Transport
  token?: string | undefined
  /** Extra cleanup after the connection closes (kill child, end SSH). */
  onClose?: (() => Promise<void> | void) | undefined
}

export class ServerEnvironment extends Environment {
  readonly client: EnvClient
  /** True when the server runs over an SSH exec channel. */
  viaServer = false
  /** SSH connection carrying the server, when `viaServer`. */
  ssh: SshClient | undefined = undefined
  /** Windows account the server runs as (winuser environments). */
  account: string | undefined = undefined
  /** Process id of a server launched for this environment, when known. */
  serverPid: number | undefined = undefined
  /** How the connection is carried (diagnostics), e.g. `ssh-forward`, `ssh-stdio`. */
  transportMode: string | undefined = undefined
  /** Address of the server as seen from its host, when it listens on one. */
  remoteEndpoint: string | undefined = undefined
  private readonly onCloseHook: (() => Promise<void> | void) | undefined

  constructor(opts: ServerEnvironmentOptions) {
    super(opts)
    this.client = new EnvClient(opts.transport, { token: opts.token ?? '' })
    this.onCloseHook = opts.onClose
    this.client.on('close', error => this.markClosed(error))
  }

  async open(signal?: AbortSignal): Promise<this> {
    this.info = normalizeInfo(await this.client.connect(signal))
    return this
  }

  override async stat(path: string, opts: StatOptions = {}): Promise<Stat | null> {
    return this.client.call('fs.stat', { path, follow: opts.follow ?? true }, undefined, opts.signal)
  }

  override async readdir(path: string, opts: SignalOptions = {}): Promise<DirEntry[]> {
    return (await this.client.call('fs.readdir', { path }, undefined, opts.signal)).entries
  }

  override async readFile(path: string, opts: ReadFileOptions = {}): Promise<Buffer> {
    const max = opts.maxBytes ?? opts.max
    if (opts.offset === undefined && opts.length === undefined && (max === undefined || max > STREAM_THRESHOLD)) {
      // Large or unbounded whole-file read: stream it.
      const st = await this.stat(path, opts)
      if (st && st.size > STREAM_THRESHOLD) {
        if (max !== undefined && st.size > max)
          throw new EnvError('ETOOBIG', `${path} is ${st.size} bytes (limit ${max})`)
        const chunks: Buffer[] = []
        for await (const c of await this.openRead(path, opts)) chunks.push(c as Buffer)
        return Buffer.concat(chunks)
      }
    }
    const { payload } = await this.client.request(
      'fs.read',
      {
        path,
        ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
        ...(opts.length !== undefined ? { length: opts.length } : {}),
        ...(max !== undefined ? { max: Math.min(max, MAX_READ) } : {}),
      },
      undefined,
      opts.signal,
    )
    return payload
  }

  override async writeFile(path: string, data: Uint8Array | string, opts: WriteFileOptions = {}): Promise<Stat> {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (buf.length > STREAM_THRESHOLD && (opts.mode ?? 'overwrite') === 'overwrite') {
      const w = await this.openWrite(path, opts)
      return w.writeAll(buf)
    }
    return this.client.call(
      'fs.write',
      { path, mode: opts.mode ?? 'overwrite', atomic: opts.atomic ?? true, mkdirs: opts.mkdirs ?? false },
      buf,
      opts.signal,
    )
  }

  override async mkdir(path: string, opts: RecursiveOptions = {}): Promise<void> {
    await this.client.call('fs.mkdir', { path, recursive: opts.recursive ?? false }, undefined, opts.signal)
  }

  override async remove(path: string, opts: RecursiveOptions = {}): Promise<void> {
    await this.client.call('fs.remove', { path, recursive: opts.recursive ?? false }, undefined, opts.signal)
  }

  override async rename(from: string, to: string, opts: RenameOptions = {}): Promise<void> {
    await this.client.call('fs.rename', { from, to, overwrite: opts.overwrite ?? false }, undefined, opts.signal)
  }

  override async copy(from: string, to: string, opts: CopyOptions = {}): Promise<void> {
    await this.client.call(
      'fs.copy',
      { from, to, recursive: opts.recursive ?? true, overwrite: opts.overwrite ?? false },
      undefined,
      opts.signal,
    )
  }

  override async realpath(path: string, opts: SignalOptions = {}): Promise<string> {
    return (await this.client.call('fs.realpath', { path }, undefined, opts.signal)).path
  }

  async openRead(path: string, opts: SignalOptions = {}): Promise<Readable> {
    const { ch } = await this.client.call('fs.readStream', { path }, undefined, opts.signal)
    const channel = this.client.channel(ch)
    const r = channel.readable(1)
    opts.signal?.addEventListener('abort', () => channel.close(), { once: true })
    return r
  }

  async openWrite(path: string, opts: WriteFileOptions = {}): Promise<WriteHandle> {
    const { ch } = await this.client.call(
      'fs.writeStream',
      { path, atomic: opts.atomic ?? true, mkdirs: opts.mkdirs ?? false },
      undefined,
      opts.signal,
    )
    const channel = this.client.channel(ch)
    const done = channel.done.then(({ result, error }) => {
      if (error) throw error
      return result as Stat
    })
    done.catch(() => {})
    return {
      stream: channel.writable(0),
      done,
      async writeAll(buf: Buffer) {
        await channel.write(buf, 0)
        channel.end(0)
        return done
      },
      abort() {
        channel.close()
      },
    }
  }

  override async glob(pattern: string, opts: GlobOptions = {}): Promise<GlobOutcome> {
    return this.client.call(
      'fs.glob',
      {
        pattern,
        cwd: opts.cwd,
        limit: opts.limit ?? 1000,
        hidden: opts.hidden ?? false,
        gitignore: opts.gitignore ?? true,
      },
      undefined,
      opts.signal,
    )
  }

  override async grep(pattern: string, opts: GrepOptions = {}): Promise<GrepOutcome> {
    const { signal, ...rest } = opts
    return this.client.call('fs.grep', { pattern, ...rest }, undefined, signal)
  }

  override async spawn(spec: SpawnSpec, opts: SignalOptions = {}): Promise<ServerProcess> {
    const { ch, pid } = await this.client.call('proc.spawn', spec, undefined, opts.signal)
    const channel = this.client.channel(ch)
    return new ServerProcess(this.client, channel, pid, !!spec.pty)
  }

  /** Forward a local port to host:port as seen from the environment. */
  override async forward({
    localHost = '127.0.0.1',
    localPort = 0,
    remoteHost = '127.0.0.1',
    remotePort,
    proto = 'tcp',
  }: ForwardOptions): Promise<Tunnel> {
    const open = proto === 'udp' ? forwardUdp : forwardTcp
    const t = await open(this.client, localHost, localPort, remoteHost, remotePort)
    return this.trackTunnel({
      kind: 'forward',
      proto,
      localHost,
      localPort: t.port,
      remoteHost,
      remotePort,
      close: t.close,
    })
  }

  /** Listen on remoteHost:remotePort in the environment and forward connections to localHost:localPort. */
  override async reverse({
    remoteHost = '127.0.0.1',
    remotePort = 0,
    localHost = '127.0.0.1',
    localPort,
    proto = 'tcp',
  }: ReverseOptions): Promise<Tunnel> {
    const t = await reverseTunnel(this.client, remoteHost, remotePort, localHost, localPort, proto)
    return this.trackTunnel({
      kind: 'reverse',
      proto,
      remoteHost,
      remotePort: t.port,
      localHost,
      localPort,
      close: t.close,
    })
  }

  override async screenshot(opts: SignalOptions = {}): Promise<Screenshot> {
    if (!this.caps.has('screenshot')) throw new EnvError('UNSUPPORTED', `${this.name} cannot take screenshots`)
    const { result, payload } = await this.client.request('sys.screenshot', {}, undefined, opts.signal)
    return { png: payload, width: result.width, height: result.height }
  }

  override async input(actions: readonly InputActionFields[], opts: SignalOptions = {}): Promise<void> {
    if (!this.caps.has('input')) throw new EnvError('UNSUPPORTED', `${this.name} does not support input injection`)
    // Actions are forwarded verbatim; the server validates them and rejects unknown kinds.
    await this.client.call('sys.input', { actions: actions as readonly InputAction[] }, undefined, opts.signal)
  }

  protected override async closeTransport(): Promise<void> {
    this.client.close()
    await this.onCloseHook?.()
  }
}

/** Fill defaults for fields an older or partial server may omit. */
export function normalizeInfo(info: Partial<Info>): Info {
  return {
    os: info.os ?? 'unknown',
    family: info.family ?? (info.pathSep === '\\' ? 'windows' : 'posix'),
    arch: info.arch ?? '',
    hostname: info.hostname ?? '',
    user: info.user ?? '',
    home: info.home ?? '',
    cwd: info.cwd ?? '',
    pathSep: info.pathSep ?? '/',
    shell: info.shell ?? '',
    caps: info.caps ?? [],
    version: info.version ?? '',
  }
}
