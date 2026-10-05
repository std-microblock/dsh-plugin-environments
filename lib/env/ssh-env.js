// SSH environment: SFTP for files, exec channels for processes, direct/remote TCP forwarding for tunnels.
// When a dsh-env-server binary is available on the remote host, `openSsh` runs it over an exec
// channel instead and returns a full-featured ServerEnvironment.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import ssh2 from 'ssh2'
import { Environment } from './environment.js'
import { EnvError } from '../protocol/client.js'
import { ServerEnvironment } from './server-env.js'
import { filterGlob, findScript, grepScript, parseGrep, shq } from './posix-shell.js'

const { Client } = ssh2

function sftpError(e, p) {
  const code = e?.code === 2 ? 'ENOENT' : e?.code === 3 ? 'EACCES' : e?.code === 4 && /exist/i.test(e.message) ? 'EEXIST' : 'EIO'
  return new EnvError(code, `${p}: ${e?.message ?? e}`)
}

function modeType(mode) {
  const t = mode & 0o170000
  return t === 0o040000 ? 'dir' : t === 0o100000 ? 'file' : t === 0o120000 ? 'symlink' : 'other'
}

/** Build ssh2 connect options from an environment config. */
export function sshConnectConfig(cfg) {
  const out = {
    host: cfg.host,
    port: cfg.port ?? 22,
    username: cfg.username ?? os.userInfo().username,
    readyTimeout: cfg.readyTimeoutMs ?? 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
  }
  if (cfg.password) out.password = cfg.password
  if (cfg.privateKeyPath) {
    const p = cfg.privateKeyPath.replace(/^~(?=$|[\\/])/, os.homedir())
    out.privateKey = fs.readFileSync(p)
    if (cfg.passphrase) out.passphrase = cfg.passphrase
  }
  if (!out.password && !out.privateKey) {
    if (process.platform === 'win32') out.agent = '\\\\.\\pipe\\openssh-ssh-agent'
    else if (process.env.SSH_AUTH_SOCK) out.agent = process.env.SSH_AUTH_SOCK
    // Fall back to default key files.
    for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
      const p = path.join(os.homedir(), '.ssh', name)
      if (!out.privateKey && fs.existsSync(p)) {
        try { out.privateKey = fs.readFileSync(p) } catch {}
      }
    }
  }
  return out
}

function connectClient(cfg, signal) {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    const onAbort = () => { conn.end(); reject(new EnvError('CANCELLED', 'aborted')) }
    signal?.addEventListener('abort', onAbort, { once: true })
    conn.once('ready', () => { signal?.removeEventListener('abort', onAbort); resolve(conn) })
    conn.once('error', e => { signal?.removeEventListener('abort', onAbort); reject(new EnvError(e.level === 'client-authentication' ? 'AUTH' : 'EIO', `ssh ${cfg.host}: ${e.message}`)) })
    try {
      conn.connect(sshConnectConfig(cfg))
    } catch (e) {
      reject(new EnvError('EINVAL', `ssh config: ${e.message}`))
    }
  })
}

function execOnce(conn, command, { input, maxBytes = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(new EnvError('EIO', err.message))
      const out = []
      const errOut = []
      let size = 0
      stream.on('data', d => { size += d.length; if (size <= maxBytes) out.push(d) })
      stream.stderr.on('data', d => errOut.push(d))
      stream.on('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(errOut).toString() }))
      if (input !== undefined) stream.end(input)
      else stream.end()
    })
  })
}

/** Bundled server binary for a remote `uname -sm`, if one ships with the plugin. */
function bundledBinaryFor(uname) {
  const [sys, machine] = uname.trim().split(/\s+/)
  if (!/^linux$/i.test(sys ?? '')) return undefined
  const arch = /^(x86_64|amd64)$/i.test(machine) ? 'x64' : /^(aarch64|arm64)$/i.test(machine) ? 'arm64' : undefined
  if (!arch) return undefined
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const file = path.join(root, 'bin', `linux-${arch}`, 'dsh-env-server')
  return fs.existsSync(file) ? file : undefined
}

/** Upload the bundled server (once per version) and return its remote path. */
async function provisionServer(conn, signal) {
  const probe = await execOnce(conn, 'uname -sm; echo "$HOME"')
  if (probe.code !== 0) return undefined
  const [uname, home] = probe.stdout.toString().split(/\r?\n/)
  const local = bundledBinaryFor(uname ?? '')
  if (!local || !home) return undefined
  const data = fs.readFileSync(local)
  const hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 12)
  const dir = `${home}/.dsh-env/bin`
  const remote = `${dir}/dsh-env-server-${hash}`
  const check = await execOnce(conn, `test -x ${shq(remote)} && wc -c < ${shq(remote)}`)
  if (check.code === 0 && Number(check.stdout.toString().trim()) === data.length) return remote
  signal?.throwIfAborted?.()
  await execOnce(conn, `mkdir -p ${shq(dir)}`)
  const sftp = await new Promise((resolve, reject) => conn.sftp((e, s) => (e ? reject(e) : resolve(s))))
  const tmp = `${remote}.part`
  try {
    await new Promise((resolve, reject) => {
      const w = sftp.createWriteStream(tmp, { mode: 0o755 })
      w.on('close', resolve)
      w.on('error', reject)
      w.end(data)
    })
  } finally {
    sftp.end()
  }
  const mv = await execOnce(conn, `chmod 755 ${shq(tmp)} && mv -f ${shq(tmp)} ${shq(remote)}`)
  if (mv.code !== 0) throw new EnvError('EIO', `could not install dsh-env-server: ${mv.stderr}`)
  return remote
}

function serverOverExec(conn, command, { id, name }) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err)
      const transport = new EventEmitter()
      stream.on('data', d => transport.emit('data', d))
      stream.on('close', () => transport.emit('close'))
      stream.on('error', e => transport.emit('error', e))
      stream.stderr.on('data', () => {})
      transport.write = buf => stream.write(buf)
      transport.end = () => stream.end()
      transport.destroy = () => { try { stream.close() } catch {} }
      resolve(new ServerEnvironment({ id, name, kind: 'ssh', transport, onClose: () => conn.end() }))
    })
  })
}

/** Open an SSH-backed environment. */
export async function openSsh({ id, name, config, signal }) {
  const conn = await connectClient(config, signal)
  let serverPath = config.serverPath
  if (!serverPath && config.install !== 'off') {
    serverPath = await provisionServer(conn, signal).catch(() => undefined)
  }
  if (serverPath) {
    try {
      const env = await serverOverExec(conn, `${shq(serverPath)} stdio${config.cwd ? ` --cwd ${shq(config.cwd)}` : ''}`, { id, name })
      conn.on('close', () => env.markClosed(new EnvError('CLOSED', 'ssh connection closed')))
      await env.open(signal)
      env.ssh = conn
      env.viaServer = true
      return env
    } catch (e) {
      if (config.serverPath) {
        conn.end()
        throw e
      }
      // Fall back to plain SFTP/exec below.
    }
  }
  const env = new SshEnvironment({ id, name, conn, config })
  await env.open()
  return env
}

class SshProcess {
  constructor(stream, pty) {
    this.stream = stream
    this.pty = pty
    this.pid = undefined
    this.stdin = stream
    this.stdout = stream
    this.stderr = stream.stderr
    this.exited = new Promise(resolve => {
      let exit
      stream.on('exit', (code, signal) => { exit = { code: code ?? null, signal: signal ?? null } })
      stream.on('close', () => resolve(exit ?? { code: null, signal: 'CLOSED' }))
    })
  }

  write(data) {
    return new Promise((resolve, reject) => this.stream.write(data, e => (e ? reject(e) : resolve())))
  }

  end() {
    this.stream.end()
  }

  async resize(rows, cols) {
    this.stream.setWindow(rows, cols, 0, 0)
  }

  async kill(signal = 'KILL') {
    try { this.stream.signal(signal) } catch {}
    try { this.stream.close() } catch {}
  }
}

export class SshEnvironment extends Environment {
  constructor({ id, name, conn, config }) {
    super({ id, name, kind: 'ssh' })
    this.conn = conn
    this.config = config
    conn.on('close', () => this.markClosed(new EnvError('CLOSED', 'ssh connection closed')))
    conn.on('error', () => {})
  }

  async open() {
    this.sftp = await new Promise((resolve, reject) => this.conn.sftp((e, s) => (e ? reject(new EnvError('EIO', `sftp: ${e.message}`)) : resolve(s))))
    const probe = await execOnce(this.conn, 'uname -s; uname -m; echo "$HOME"; pwd; echo "$SHELL"; id -un; hostname')
    const lines = probe.stdout.toString().split(/\r?\n/)
    const windows = probe.code !== 0 || !/^(Linux|Darwin|FreeBSD|OpenBSD|NetBSD|SunOS|CYGWIN|MINGW|MSYS)/i.test(lines[0] ?? '')
    if (windows) {
      const home = (await this.realpathSftp('.').catch(() => 'C:/Users')).replace(/^\/([A-Za-z]:)/, '$1')
      this.info = { os: 'windows', family: 'windows', arch: '', hostname: this.config.host, user: this.config.username ?? '', home, cwd: this.config.cwd ?? home, pathSep: '\\', shell: 'cmd.exe', caps: ['fs', 'proc', 'pty', 'tcp', 'tcp-listen'], version: 'ssh' }
    } else {
      const [uname, arch, home, pwd, shell, user, host] = lines
      this.info = {
        os: /darwin/i.test(uname) ? 'macos' : uname.toLowerCase(), family: 'posix', arch, hostname: host || this.config.host, user,
        home, cwd: this.config.cwd ?? pwd ?? home, pathSep: '/', shell: shell || '/bin/sh',
        caps: ['fs', 'glob', 'grep', 'proc', 'pty', 'tcp', 'tcp-listen'], version: 'ssh',
      }
    }
    return this
  }

  sftpPath(p) {
    // OpenSSH for Windows expects /C:/path; posix paths pass through.
    if (this.family === 'windows' && /^[A-Za-z]:/.test(p)) return `/${p.replace(/\\/g, '/')}`
    return p
  }

  realpathSftp(p) {
    return new Promise((resolve, reject) => this.sftp.realpath(p, (e, r) => (e ? reject(sftpError(e, p)) : resolve(r))))
  }

  sftpCall(method, ...args) {
    return new Promise((resolve, reject) => this.sftp[method](...args, (e, r) => (e ? reject(e) : resolve(r))))
  }

  async stat(p, opts = {}) {
    try {
      const s = await this.sftpCall(opts.follow === false ? 'lstat' : 'stat', this.sftpPath(p))
      return { type: modeType(s.mode), size: s.size, mtimeMs: s.mtime * 1000, mode: s.mode & 0o7777 }
    } catch (e) {
      if (e?.code === 2) return null
      throw sftpError(e, p)
    }
  }

  async readdir(p) {
    let list
    try {
      list = await this.sftpCall('readdir', this.sftpPath(p))
    } catch (e) {
      throw sftpError(e, p)
    }
    return list
      .filter(e => e.filename !== '.' && e.filename !== '..')
      .map(e => ({ name: e.filename, type: modeType(e.attrs.mode), size: e.attrs.size, mtimeMs: e.attrs.mtime * 1000 }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  async readFile(p, opts = {}) {
    const st = await this.stat(p)
    if (!st) throw new EnvError('ENOENT', `no such file: ${p}`)
    if (st.type === 'dir') throw new EnvError('EISDIR', `is a directory: ${p}`)
    const start = opts.offset ?? 0
    const end = opts.length !== undefined ? Math.min(st.size, start + opts.length) : st.size
    const max = opts.maxBytes ?? opts.max ?? 256 * 1024 * 1024
    if (end - start > max) throw new EnvError('ETOOBIG', `${p} is ${st.size} bytes (limit ${max})`)
    if (end <= start) return Buffer.alloc(0)
    const chunks = []
    await new Promise((resolve, reject) => {
      const s = this.sftp.createReadStream(this.sftpPath(p), { start, end: end - 1 })
      s.on('data', d => chunks.push(d))
      s.on('end', resolve)
      s.on('error', e => reject(sftpError(e, p)))
    })
    return Buffer.concat(chunks)
  }

  async writeFile(p, data, opts = {}) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    const P = this.path
    if (opts.mkdirs) await this.mkdir(P.dirname(p), { recursive: true })
    const mode = opts.mode ?? 'overwrite'
    if (mode === 'create' && await this.stat(p)) throw new EnvError('EEXIST', `already exists: ${p}`)
    const write = (target, flags) => new Promise((resolve, reject) => {
      const s = this.sftp.createWriteStream(this.sftpPath(target), { flags })
      s.on('close', resolve)
      s.on('error', e => reject(sftpError(e, target)))
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
        await this.sftpCall('unlink', this.sftpPath(tmp)).catch(() => {})
        throw e
      }
    }
    return this.stat(p)
  }

  async renameReplace(from, to) {
    try {
      if (typeof this.sftp.ext_openssh_rename === 'function') {
        await this.sftpCall('ext_openssh_rename', this.sftpPath(from), this.sftpPath(to))
        return
      }
    } catch {}
    try {
      await this.sftpCall('rename', this.sftpPath(from), this.sftpPath(to))
    } catch (e) {
      if (await this.stat(to)) {
        await this.sftpCall('unlink', this.sftpPath(to))
        await this.sftpCall('rename', this.sftpPath(from), this.sftpPath(to))
      } else throw sftpError(e, to)
    }
  }

  async mkdir(p, opts = {}) {
    if (opts.recursive) {
      const st = await this.stat(p)
      if (st?.type === 'dir') return
      const parent = this.path.dirname(p)
      if (parent !== p) await this.mkdir(parent, { recursive: true })
    }
    try {
      await this.sftpCall('mkdir', this.sftpPath(p))
    } catch (e) {
      if (opts.recursive && (await this.stat(p))?.type === 'dir') return
      throw sftpError(e, p)
    }
  }

  async remove(p, opts = {}) {
    const st = await this.stat(p, { follow: false })
    if (!st) throw new EnvError('ENOENT', `no such file: ${p}`)
    if (st.type === 'dir') {
      if (opts.recursive) {
        for (const e of await this.readdir(p)) await this.remove(this.path.join(p, e.name), { recursive: true })
      }
      await this.sftpCall('rmdir', this.sftpPath(p)).catch(e => { throw sftpError(e, p) })
    } else {
      await this.sftpCall('unlink', this.sftpPath(p)).catch(e => { throw sftpError(e, p) })
    }
  }

  async rename(from, to, opts = {}) {
    if (!opts.overwrite && await this.stat(to, { follow: false })) throw new EnvError('EEXIST', `already exists: ${to}`)
    await this.renameReplace(from, to)
  }

  async realpath(p) {
    const r = await this.realpathSftp(this.sftpPath(p))
    return this.family === 'windows' ? r.replace(/^\/([A-Za-z]:)/, '$1') : r
  }

  async glob(pattern, opts = {}) {
    const cwd = opts.cwd ?? this.info.cwd
    if (this.family === 'windows') return walkGlob(this, pattern, { ...opts, cwd })
    const r = await execOnce(this.conn, findScript(cwd, { hidden: opts.hidden }))
    return { ...filterGlob(r.stdout.toString(), pattern, opts.limit ?? 1000), cwd }
  }

  async grep(pattern, opts = {}) {
    const cwd = opts.cwd ?? this.info.cwd
    if (this.family === 'windows') throw new EnvError('UNSUPPORTED', 'grep over plain SSH needs a POSIX host; install dsh-env-server on Windows hosts')
    const r = await execOnce(this.conn, grepScript(cwd, pattern, opts))
    return { ...parseGrep(r.stdout.toString(), { filesOnly: opts.filesOnly, limit: opts.limit ?? 500, glob: opts.glob }), cwd }
  }

  async spawn(spec) {
    let command = spec.command ?? spec.argv.map(a => (this.family === 'windows' ? JSON.stringify(a) : shq(a))).join(' ')
    if (this.family === 'posix') {
      const envPrefix = Object.entries(spec.env ?? {}).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${shq(v)}`).join(' ')
      if (envPrefix) command = `export ${envPrefix}; ${command}`
      if (spec.cwd) command = `cd ${shq(spec.cwd)} && ${command}`
    } else if (spec.cwd) {
      command = `cd /d "${spec.cwd}" && ${command}`
    }
    const stream = await new Promise((resolve, reject) => {
      const opts = spec.pty ? { pty: { rows: spec.pty.rows ?? 24, cols: spec.pty.cols ?? 80, term: 'xterm-256color' } } : {}
      this.conn.exec(command, opts, (err, s) => (err ? reject(new EnvError('EIO', err.message)) : resolve(s)))
    })
    return new SshProcess(stream, !!spec.pty)
  }

  async forward({ localHost = '127.0.0.1', localPort = 0, remoteHost = '127.0.0.1', remotePort, proto = 'tcp' }) {
    if (proto !== 'tcp') throw new EnvError('UNSUPPORTED', 'ssh forwards TCP only (install dsh-env-server for UDP)')
    const server = net.createServer(socket => {
      this.conn.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, remoteHost, remotePort, (err, stream) => {
        if (err) return socket.destroy()
        socket.pipe(stream).pipe(socket)
        stream.on('close', () => socket.destroy())
        socket.on('close', () => stream.close?.())
        socket.on('error', () => {})
      })
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(localPort, localHost, resolve) })
    return this.trackTunnel({
      kind: 'forward', proto, localHost, localPort: server.address().port, remoteHost, remotePort,
      close: () => new Promise(r => server.close(() => r())),
    })
  }

  async reverse({ remoteHost = '127.0.0.1', remotePort = 0, localHost = '127.0.0.1', localPort, proto = 'tcp' }) {
    if (proto !== 'tcp') throw new EnvError('UNSUPPORTED', 'ssh reverse-forwards TCP only')
    const port = await new Promise((resolve, reject) => this.conn.forwardIn(remoteHost, remotePort, (e, p) => (e ? reject(new EnvError('EIO', `remote forward refused: ${e.message}`)) : resolve(p || remotePort))))
    const onConn = (info, accept) => {
      if (info.destPort !== port) return
      const stream = accept()
      const socket = net.connect(localPort, localHost)
      socket.pipe(stream).pipe(socket)
      socket.on('error', () => stream.close?.())
      stream.on('close', () => socket.destroy())
    }
    this.conn.on('tcp connection', onConn)
    return this.trackTunnel({
      kind: 'reverse', proto, remoteHost, remotePort: port, localHost, localPort,
      close: async () => {
        this.conn.off('tcp connection', onConn)
        await new Promise(r => this.conn.unforwardIn(remoteHost, port, () => r()))
      },
    })
  }

  async closeTransport() {
    try { this.sftp?.end() } catch {}
    this.conn.end()
  }
}

/** Glob by walking readdir (for environments without find). */
export async function walkGlob(env, pattern, { cwd, limit = 1000, hidden = false, signal } = {}) {
  const { globToRegExp } = await import('./posix-shell.js')
  const re = globToRegExp(pattern)
  const P = env.path
  const paths = []
  let truncated = false
  let visited = 0
  const walk = async (dir, rel) => {
    if (truncated || signal?.aborted) return
    let entries
    try { entries = await env.readdir(dir) } catch { return }
    for (const e of entries) {
      if (!hidden && e.name.startsWith('.')) continue
      if (e.name === 'node_modules' || e.name === '.git') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (re.test(r)) {
        if (paths.length >= limit) { truncated = true; return }
        paths.push(r)
      }
      if (e.type === 'dir' && ++visited < 20000) await walk(P.join(dir, e.name), r)
    }
  }
  await walk(cwd, '')
  return { paths, truncated, cwd }
}
