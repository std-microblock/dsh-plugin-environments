// SSH environment without dsh-env-server: SFTP for files, exec channels for processes,
// direct/remote TCP forwarding for tunnels.
import net from 'node:net'
import type {
  AcceptConnection,
  Client as SshClient,
  ClientChannel,
  OpenMode,
  SFTPWrapper,
  Stats as SftpStats,
  TcpConnectionDetails,
} from 'ssh2'
import { EnvError, errorMessage, type DirEntry, type FileType, type Stat } from '@dsh-environments/protocol'
import { Environment } from '../environment.ts'
import { byName, filterGlob, findScript, grepScript, parseGrep, shq } from '../posix-shell.ts'
import type {
  ForwardOptions,
  GlobOptions,
  GlobOutcome,
  GrepOptions,
  GrepOutcome,
  RecursiveOptions,
  RenameOptions,
  ReverseOptions,
  ReadFileOptions,
  SpawnSpec,
  StatOptions,
  Tunnel,
  WriteFileOptions,
} from '../types.ts'
import { execOnce, type SshConfig } from './connection.ts'
import { SshProcess } from './ssh-process.ts'
import { walkGlob } from './walk-glob.ts'

/** SFTP status codes (draft-ietf-secsh-filexfer): 2 = no such file, 3 = permission denied, 4 = failure. */
function sftpError(e: unknown, p: string): EnvError {
  const status = (e as { code?: unknown } | undefined)?.code
  const message = errorMessage(e)
  const code =
    status === 2 ? 'ENOENT' : status === 3 ? 'EACCES' : status === 4 && /exist/i.test(message) ? 'EEXIST' : 'EIO'
  return new EnvError(code, `${p}: ${message}`)
}

function modeType(mode: number): FileType {
  const t = mode & 0o170000
  return t === 0o040000 ? 'dir' : t === 0o100000 ? 'file' : t === 0o120000 ? 'symlink' : 'other'
}

type SftpCallback<R> = (err: Error | null | undefined, result: R) => void

export interface SshEnvironmentOptions {
  id: string
  name?: string | undefined
  conn: SshClient
  config: SshConfig
}

export class SshEnvironment extends Environment {
  readonly conn: SshClient
  readonly config: SshConfig
  private sftpHandle: SFTPWrapper | undefined

  constructor({ id, name, conn, config }: SshEnvironmentOptions) {
    super({ id, name, kind: 'ssh' })
    this.conn = conn
    this.config = config
    conn.on('close', () => this.markClosed(new EnvError('CLOSED', 'ssh connection closed')))
    conn.on('error', () => {})
  }

  private get sftp(): SFTPWrapper {
    if (!this.sftpHandle) throw new EnvError('CLOSED', 'sftp session is not open')
    return this.sftpHandle
  }

  async open(): Promise<this> {
    this.sftpHandle = await new Promise<SFTPWrapper>((resolve, reject) =>
      this.conn.sftp((e, s) => (e ? reject(new EnvError('EIO', `sftp: ${e.message}`)) : resolve(s))),
    )
    const probe = await execOnce(this.conn, 'uname -s; uname -m; echo "$HOME"; pwd; echo "$SHELL"; id -un; hostname')
    const lines = probe.stdout.toString().split(/\r?\n/)
    const windows =
      probe.code !== 0 || !/^(Linux|Darwin|FreeBSD|OpenBSD|NetBSD|SunOS|CYGWIN|MINGW|MSYS)/i.test(lines[0] ?? '')
    if (windows) {
      const home = (await this.realpathSftp('.').catch(() => 'C:/Users')).replace(/^\/([A-Za-z]:)/, '$1')
      this.info = {
        os: 'windows',
        family: 'windows',
        arch: '',
        hostname: this.config.host,
        user: this.config.username ?? '',
        home,
        cwd: this.config.cwd ?? home,
        pathSep: '\\',
        shell: 'cmd.exe',
        caps: ['fs', 'proc', 'pty', 'tcp', 'tcp-listen'],
        version: 'ssh',
      }
    } else {
      const [uname = '', arch = '', home = '', pwd, shell, user = '', host] = lines
      this.info = {
        os: /darwin/i.test(uname) ? 'macos' : uname.toLowerCase(),
        family: 'posix',
        arch,
        hostname: host || this.config.host,
        user,
        home,
        cwd: this.config.cwd ?? pwd ?? home,
        pathSep: '/',
        shell: shell || '/bin/sh',
        caps: ['fs', 'glob', 'grep', 'proc', 'pty', 'tcp', 'tcp-listen'],
        version: 'ssh',
      }
    }
    return this
  }

  /** OpenSSH for Windows expects /C:/path; posix paths pass through. */
  private sftpPath(p: string): string {
    if (this.family === 'windows' && /^[A-Za-z]:/.test(p)) return `/${p.replace(/\\/g, '/')}`
    return p
  }

  private realpathSftp(p: string): Promise<string> {
    return new Promise((resolve, reject) => this.sftp.realpath(p, (e, r) => (e ? reject(sftpError(e, p)) : resolve(r))))
  }

  /** Promisify one SFTP call; rejects with the raw SFTP error. */
  private sftpCall<R>(fn: (cb: SftpCallback<R>) => void): Promise<R> {
    return new Promise((resolve, reject) => fn((e, r) => (e ? reject(e) : resolve(r))))
  }

  /** Promisify one result-less SFTP call; rejects with the raw SFTP error. */
  private sftpDo(fn: (cb: (err?: Error | null) => void) => void): Promise<void> {
    return new Promise((resolve, reject) => fn(e => (e ? reject(e) : resolve())))
  }

  override async stat(p: string, opts: StatOptions = {}): Promise<Stat | null> {
    try {
      const target = this.sftpPath(p)
      const s = await this.sftpCall<SftpStats>(cb =>
        opts.follow === false ? this.sftp.lstat(target, cb) : this.sftp.stat(target, cb),
      )
      return { type: modeType(s.mode), size: s.size, mtimeMs: s.mtime * 1000, mode: s.mode & 0o7777 }
    } catch (e) {
      if ((e as { code?: unknown } | undefined)?.code === 2) return null
      throw sftpError(e, p)
    }
  }

  override async readdir(p: string): Promise<DirEntry[]> {
    let list
    try {
      list = await this.sftpCall<{ filename: string; attrs: SftpStats }[]>(cb =>
        this.sftp.readdir(this.sftpPath(p), cb),
      )
    } catch (e) {
      throw sftpError(e, p)
    }
    return list
      .filter(e => e.filename !== '.' && e.filename !== '..')
      .map(e => ({ name: e.filename, type: modeType(e.attrs.mode), size: e.attrs.size, mtimeMs: e.attrs.mtime * 1000 }))
      .sort(byName)
  }

  override async readFile(p: string, opts: ReadFileOptions = {}): Promise<Buffer> {
    const st = await this.stat(p)
    if (!st) throw new EnvError('ENOENT', `no such file: ${p}`)
    if (st.type === 'dir') throw new EnvError('EISDIR', `is a directory: ${p}`)
    const start = opts.offset ?? 0
    const end = opts.length !== undefined ? Math.min(st.size, start + opts.length) : st.size
    const max = opts.maxBytes ?? opts.max ?? 256 * 1024 * 1024
    if (end - start > max) throw new EnvError('ETOOBIG', `${p} is ${st.size} bytes (limit ${max})`)
    if (end <= start) return Buffer.alloc(0)
    const chunks: Buffer[] = []
    await new Promise((resolve, reject) => {
      const s = this.sftp.createReadStream(this.sftpPath(p), { start, end: end - 1 })
      s.on('data', (d: Buffer) => chunks.push(d))
      s.on('end', resolve)
      s.on('error', (e: Error) => reject(sftpError(e, p)))
    })
    return Buffer.concat(chunks)
  }

  override async writeFile(p: string, data: Uint8Array | string, opts: WriteFileOptions = {}): Promise<Stat | null> {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    const P = this.path
    if (opts.mkdirs) await this.mkdir(P.dirname(p), { recursive: true })
    const mode = opts.mode ?? 'overwrite'
    if (mode === 'create' && (await this.stat(p))) throw new EnvError('EEXIST', `already exists: ${p}`)
    const write = (target: string, flags: OpenMode) =>
      new Promise((resolve, reject) => {
        const s = this.sftp.createWriteStream(this.sftpPath(target), { flags })
        s.on('close', resolve)
        s.on('error', (e: Error) => reject(sftpError(e, target)))
        s.end(buf)
      })
    if (mode === 'append') {
      await write(p, 'a')
    } else if (opts.atomic === false) {
      await write(p, 'w')
    } else {
      const tmp = P.join(P.dirname(p), `.${P.basename(p)}.dsh-tmp-${Date.now().toString(16)}`)
      await write(tmp, 'w')
      try {
        await this.renameReplace(tmp, p)
      } catch (e) {
        await this.sftpDo(cb => this.sftp.unlink(this.sftpPath(tmp), cb)).catch(() => {})
        throw e
      }
    }
    return this.stat(p)
  }

  /** Rename, replacing an existing target (posix-rename extension when available). */
  private async renameReplace(from: string, to: string): Promise<void> {
    const src = this.sftpPath(from)
    const dst = this.sftpPath(to)
    try {
      if (typeof this.sftp.ext_openssh_rename === 'function') {
        await this.sftpDo(cb => this.sftp.ext_openssh_rename(src, dst, cb))
        return
      }
    } catch {
      // fall back to plain rename
    }
    try {
      await this.sftpDo(cb => this.sftp.rename(src, dst, cb))
    } catch (e) {
      if (await this.stat(to)) {
        await this.sftpDo(cb => this.sftp.unlink(dst, cb))
        await this.sftpDo(cb => this.sftp.rename(src, dst, cb))
      } else throw sftpError(e, to)
    }
  }

  override async mkdir(p: string, opts: RecursiveOptions = {}): Promise<void> {
    if (opts.recursive) {
      const st = await this.stat(p)
      if (st?.type === 'dir') return
      const parent = this.path.dirname(p)
      if (parent !== p) await this.mkdir(parent, { recursive: true })
    }
    try {
      await this.sftpDo(cb => this.sftp.mkdir(this.sftpPath(p), cb))
    } catch (e) {
      if (opts.recursive && (await this.stat(p))?.type === 'dir') return
      throw sftpError(e, p)
    }
  }

  override async remove(p: string, opts: RecursiveOptions = {}): Promise<void> {
    const st = await this.stat(p, { follow: false })
    if (!st) throw new EnvError('ENOENT', `no such file: ${p}`)
    if (st.type === 'dir') {
      if (opts.recursive) {
        for (const e of await this.readdir(p)) await this.remove(this.path.join(p, e.name), { recursive: true })
      }
      await this.sftpDo(cb => this.sftp.rmdir(this.sftpPath(p), cb)).catch((e: unknown) => {
        throw sftpError(e, p)
      })
    } else {
      await this.sftpDo(cb => this.sftp.unlink(this.sftpPath(p), cb)).catch((e: unknown) => {
        throw sftpError(e, p)
      })
    }
  }

  override async rename(from: string, to: string, opts: RenameOptions = {}): Promise<void> {
    if (!opts.overwrite && (await this.stat(to, { follow: false })))
      throw new EnvError('EEXIST', `already exists: ${to}`)
    await this.renameReplace(from, to)
  }

  override async realpath(p: string): Promise<string> {
    const r = await this.realpathSftp(this.sftpPath(p))
    return this.family === 'windows' ? r.replace(/^\/([A-Za-z]:)/, '$1') : r
  }

  override async glob(pattern: string, opts: GlobOptions = {}): Promise<GlobOutcome> {
    const cwd = opts.cwd ?? this.info?.cwd ?? ''
    if (this.family === 'windows') return walkGlob(this, pattern, { ...opts, cwd })
    const r = await execOnce(this.conn, findScript(cwd, { hidden: opts.hidden }))
    return { ...filterGlob(r.stdout.toString(), pattern, opts.limit ?? 1000), cwd }
  }

  override async grep(pattern: string, opts: GrepOptions = {}): Promise<GrepOutcome> {
    const cwd = opts.cwd ?? this.info?.cwd ?? ''
    if (this.family === 'windows') {
      throw new EnvError(
        'UNSUPPORTED',
        'grep over plain SSH needs a POSIX host; install dsh-env-server on Windows hosts',
      )
    }
    const r = await execOnce(this.conn, grepScript(cwd, pattern, opts))
    return {
      ...parseGrep(r.stdout.toString(), { filesOnly: opts.filesOnly, limit: opts.limit ?? 500, glob: opts.glob }),
      cwd,
    }
  }

  override async spawn(spec: SpawnSpec): Promise<SshProcess> {
    let command =
      spec.command ?? (spec.argv ?? []).map(a => (this.family === 'windows' ? JSON.stringify(a) : shq(a))).join(' ')
    if (this.family === 'posix') {
      const envPrefix = Object.entries(spec.env ?? {})
        .filter(([, v]) => v !== null)
        .map(([k, v]) => `${k}=${shq(v)}`)
        .join(' ')
      if (envPrefix) command = `export ${envPrefix}; ${command}`
      if (spec.cwd) command = `cd ${shq(spec.cwd)} && ${command}`
    } else if (spec.cwd) {
      command = `cd /d "${spec.cwd}" && ${command}`
    }
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      const opts = spec.pty
        ? { pty: { rows: spec.pty.rows ?? 24, cols: spec.pty.cols ?? 80, term: 'xterm-256color' } }
        : {}
      this.conn.exec(command, opts, (err, s) => (err ? reject(new EnvError('EIO', err.message)) : resolve(s)))
    })
    return new SshProcess(stream, !!spec.pty)
  }

  override async forward({
    localHost = '127.0.0.1',
    localPort = 0,
    remoteHost = '127.0.0.1',
    remotePort,
    proto = 'tcp',
  }: ForwardOptions): Promise<Tunnel> {
    if (proto !== 'tcp') throw new EnvError('UNSUPPORTED', 'ssh forwards TCP only (install dsh-env-server for UDP)')
    const server = net.createServer(socket => {
      this.conn.forwardOut(
        socket.remoteAddress ?? '127.0.0.1',
        socket.remotePort ?? 0,
        remoteHost,
        remotePort,
        (err, stream) => {
          if (err) {
            socket.destroy()
            return
          }
          socket.pipe(stream).pipe(socket)
          stream.on('close', () => socket.destroy())
          socket.on('close', () => stream.close())
          socket.on('error', () => {})
        },
      )
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(localPort, localHost, resolve)
    })
    return this.trackTunnel({
      kind: 'forward',
      proto,
      localHost,
      localPort: (server.address() as net.AddressInfo).port,
      remoteHost,
      remotePort,
      close: () => new Promise<void>(r => server.close(() => r())),
    })
  }

  override async reverse({
    remoteHost = '127.0.0.1',
    remotePort = 0,
    localHost = '127.0.0.1',
    localPort,
    proto = 'tcp',
  }: ReverseOptions): Promise<Tunnel> {
    if (proto !== 'tcp') throw new EnvError('UNSUPPORTED', 'ssh reverse-forwards TCP only')
    const port = await new Promise<number>((resolve, reject) =>
      this.conn.forwardIn(remoteHost, remotePort, (e, p) =>
        e ? reject(new EnvError('EIO', `remote forward refused: ${e.message}`)) : resolve(p || remotePort),
      ),
    )
    const onConn = (info: TcpConnectionDetails, accept: AcceptConnection<ClientChannel>) => {
      if (info.destPort !== port) return
      const stream = accept()
      const socket = net.connect(localPort, localHost)
      socket.pipe(stream).pipe(socket)
      socket.on('error', () => stream.close())
      stream.on('close', () => socket.destroy())
    }
    this.conn.on('tcp connection', onConn)
    return this.trackTunnel({
      kind: 'reverse',
      proto,
      remoteHost,
      remotePort: port,
      localHost,
      localPort,
      close: async () => {
        this.conn.off('tcp connection', onConn)
        await new Promise<void>(r => this.conn.unforwardIn(remoteHost, port, () => r()))
      },
    })
  }

  protected override closeTransport(): Promise<void> {
    try {
      this.sftpHandle?.end()
    } catch {
      // already closed
    }
    this.conn.end()
    return Promise.resolve()
  }
}
