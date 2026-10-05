// Environment implementation backed by a dsh-env-server connection.
import net from 'node:net'
import dgram from 'node:dgram'
import { Readable } from 'node:stream'
import { EnvClient, EnvError } from '../protocol/client.js'
import { Environment } from './environment.js'

/**
 * A process running in an environment.
 * stdin: Writable, stdout/stderr: Readable, exited: Promise<{code, signal}>.
 */
export class ServerProcess {
  constructor(channel, pid, pty) {
    this.channel = channel
    this.pid = pid
    this.pty = pty
    this.stdin = channel.writable(0)
    this.stdout = channel.readable(1)
    this.stderr = pty ? Readable.from([]) : channel.readable(2)
    this.exited = new Promise(resolve => {
      channel.once('exit', exit => resolve(exit))
      channel.done.then(({ error }) => {
        if (channel.exit) resolve(channel.exit)
        else resolve({ code: null, signal: error ? 'DISCONNECTED' : 'KILLED' })
      })
    })
  }

  write(data) {
    return this.channel.write(data, 0)
  }

  end() {
    this.channel.end(0)
  }

  async resize(rows, cols) {
    await this.channel.client.call('proc.resize', { ch: this.channel.ch, rows, cols })
  }

  async kill(signal = 'KILL') {
    if (this.channel.closed) return
    try {
      await this.channel.client.call('proc.kill', { ch: this.channel.ch, signal })
    } catch {
      this.channel.close()
    }
  }
}

function pipeChannelSocket(channel, socket) {
  const r = channel.readable(1)
  r.pipe(socket)
  socket.on('data', d => {
    socket.pause()
    channel.write(d, 0).then(() => socket.resume(), () => socket.destroy())
  })
  socket.on('end', () => channel.end(0))
  socket.on('error', () => channel.close())
  socket.on('close', () => channel.close())
  channel.once('close', () => socket.destroy())
}

export class ServerEnvironment extends Environment {
  /**
   * @param {object} opts
   * @param {object} opts.transport - duplex transport (net.Socket or childTransport())
   * @param {string} [opts.token]
   * @param {() => Promise<void>|void} [opts.onClose] - extra cleanup (kill child, close ssh)
   */
  constructor(opts) {
    super(opts)
    this.client = new EnvClient(opts.transport, { token: opts.token ?? '' })
    this.onCloseHook = opts.onClose
    this.client.on('close', error => this.markClosed(error))
  }

  async open(signal) {
    this.info = normalizeInfo(await this.client.connect(signal))
    return this
  }

  get caps() {
    return new Set(this.info?.caps ?? [])
  }

  call(op, args, payload, signal) {
    return this.client.call(op, args, payload, signal)
  }

  async stat(path, opts = {}) {
    return this.call('fs.stat', { path, follow: opts.follow ?? true }, undefined, opts.signal)
  }

  async readdir(path, opts = {}) {
    return (await this.call('fs.readdir', { path }, undefined, opts.signal)).entries
  }

  async readFile(path, opts = {}) {
    const max = opts.maxBytes ?? opts.max
    if (opts.offset === undefined && opts.length === undefined && (max === undefined || max > 15 * 1024 * 1024)) {
      // Large or unbounded whole-file read: stream it.
      const st = await this.stat(path, opts)
      if (st && st.size > 15 * 1024 * 1024) {
        if (max !== undefined && st.size > max) throw new EnvError('ETOOBIG', `${path} is ${st.size} bytes (limit ${max})`)
        const chunks = []
        for await (const c of await this.openRead(path, opts)) chunks.push(c)
        return Buffer.concat(chunks)
      }
    }
    const { payload } = await this.client.request('fs.read', {
      path,
      ...opts.offset !== undefined ? { offset: opts.offset } : {},
      ...opts.length !== undefined ? { length: opts.length } : {},
      ...max !== undefined ? { max: Math.min(max, 16 * 1024 * 1024) } : {},
    }, undefined, opts.signal)
    return payload
  }

  async writeFile(path, data, opts = {}) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (buf.length > 15 * 1024 * 1024 && (opts.mode ?? 'overwrite') === 'overwrite') {
      const w = await this.openWrite(path, opts)
      return w.writeAll(buf)
    }
    return this.call('fs.write', { path, mode: opts.mode ?? 'overwrite', atomic: opts.atomic ?? true, mkdirs: opts.mkdirs ?? false }, buf, opts.signal)
  }

  async mkdir(path, opts = {}) {
    await this.call('fs.mkdir', { path, recursive: opts.recursive ?? false }, undefined, opts.signal)
  }

  async remove(path, opts = {}) {
    await this.call('fs.remove', { path, recursive: opts.recursive ?? false }, undefined, opts.signal)
  }

  async rename(from, to, opts = {}) {
    await this.call('fs.rename', { from, to, overwrite: opts.overwrite ?? false }, undefined, opts.signal)
  }

  async copy(from, to, opts = {}) {
    await this.call('fs.copy', { from, to, recursive: opts.recursive ?? true, overwrite: opts.overwrite ?? false }, undefined, opts.signal)
  }

  async realpath(path, opts = {}) {
    return (await this.call('fs.realpath', { path }, undefined, opts.signal)).path
  }

  async openRead(path, opts = {}) {
    const { ch } = await this.call('fs.readStream', { path }, undefined, opts.signal)
    const channel = this.client.channel(ch)
    const r = channel.readable(1)
    opts.signal?.addEventListener('abort', () => channel.close(), { once: true })
    return r
  }

  /** Returns { stream: Writable, done: Promise<Stat>, writeAll(buf) }. */
  async openWrite(path, opts = {}) {
    const { ch } = await this.call('fs.writeStream', { path, atomic: opts.atomic ?? true, mkdirs: opts.mkdirs ?? false }, undefined, opts.signal)
    const channel = this.client.channel(ch)
    const done = channel.done.then(({ result, error }) => {
      if (error) throw error
      return result
    })
    done.catch(() => {})
    return {
      stream: channel.writable(0),
      done,
      async writeAll(buf) {
        await channel.write(buf, 0)
        channel.end(0)
        return done
      },
      abort() { channel.close() },
    }
  }

  async glob(pattern, opts = {}) {
    return this.call('fs.glob', { pattern, cwd: opts.cwd, limit: opts.limit ?? 1000, hidden: opts.hidden ?? false, gitignore: opts.gitignore ?? true }, undefined, opts.signal)
  }

  async grep(pattern, opts = {}) {
    const { signal, ...rest } = opts
    return this.call('fs.grep', { pattern, ...rest }, undefined, signal)
  }

  async spawn(spec, opts = {}) {
    const { ch, pid } = await this.call('proc.spawn', spec, undefined, opts.signal)
    const channel = this.client.channel(ch)
    return new ServerProcess(channel, pid, !!spec.pty)
  }

  /** Forward a local port to host:port as seen from the environment. */
  async forward({ localHost = '127.0.0.1', localPort = 0, remoteHost = '127.0.0.1', remotePort, proto = 'tcp' }) {
    if (proto === 'udp') return this.forwardUdp({ localHost, localPort, remoteHost, remotePort })
    const server = net.createServer(socket => {
      socket.pause()
      this.call('net.connect', { host: remoteHost, port: remotePort, proto: 'tcp' }).then(({ ch }) => {
        pipeChannelSocket(this.client.channel(ch), socket)
        socket.resume()
      }, () => socket.destroy())
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(localPort, localHost, resolve)
    })
    const port = server.address().port
    return this.trackTunnel({
      kind: 'forward', proto, localHost, localPort: port, remoteHost, remotePort,
      close: () => new Promise(resolve => server.close(() => resolve())),
    })
  }

  async forwardUdp({ localHost, localPort, remoteHost, remotePort }) {
    const sock = dgram.createSocket(localHost.includes(':') ? 'udp6' : 'udp4')
    await new Promise((resolve, reject) => {
      sock.once('error', reject)
      sock.bind(localPort, localHost, resolve)
    })
    const peers = new Map()
    sock.on('message', async (msg, rinfo) => {
      const key = `${rinfo.address}:${rinfo.port}`
      let entry = peers.get(key)
      if (!entry) {
        entry = { ready: this.call('net.connect', { host: remoteHost, port: remotePort, proto: 'udp' }).then(({ ch }) => {
          const channel = this.client.channel(ch)
          channel.readable(1).on('data', d => sock.send(d, rinfo.port, rinfo.address))
          channel.once('close', () => peers.delete(key))
          return channel
        }) }
        peers.set(key, entry)
      }
      try {
        const channel = await entry.ready
        await channel.write(msg, 0)
      } catch {
        peers.delete(key)
      }
    })
    return this.trackTunnel({
      kind: 'forward', proto: 'udp', localHost, localPort: sock.address().port, remoteHost, remotePort,
      close: async () => {
        for (const e of peers.values()) e.ready.then(c => c.close(), () => {})
        await new Promise(resolve => sock.close(() => resolve()))
      },
    })
  }

  /** Listen on remoteHost:remotePort in the environment and forward connections to localHost:localPort. */
  async reverse({ remoteHost = '127.0.0.1', remotePort = 0, localHost = '127.0.0.1', localPort, proto = 'tcp' }) {
    const { id, port } = await this.call('net.listen', { host: remoteHost, port: remotePort, proto })
    let off
    if (proto === 'udp') {
      off = this.client.onListener(id, channel => {
        const sock = dgram.createSocket(localHost.includes(':') ? 'udp6' : 'udp4')
        sock.connect(localPort, localHost, () => {
          channel.readable(1).on('data', d => sock.send(d))
        })
        sock.on('message', msg => channel.write(msg, 0).catch(() => {}))
        sock.on('error', () => channel.close())
        channel.once('close', () => { try { sock.close() } catch {} })
      })
    } else {
      off = this.client.onListener(id, channel => {
        const socket = net.connect(localPort, localHost)
        socket.once('connect', () => pipeChannelSocket(channel, socket))
        socket.once('error', () => channel.close())
      })
    }
    return this.trackTunnel({
      kind: 'reverse', proto, remoteHost, remotePort: port, localHost, localPort,
      close: async () => {
        off()
        await this.call('net.unlisten', { id }).catch(() => {})
      },
    })
  }

  async screenshot(opts = {}) {
    if (!this.caps.has('screenshot')) throw new EnvError('UNSUPPORTED', `${this.name} cannot take screenshots`)
    const { result, payload } = await this.client.request('sys.screenshot', {}, undefined, opts.signal)
    return { png: payload, width: result.width, height: result.height }
  }

  async input(actions, opts = {}) {
    if (!this.caps.has('input')) throw new EnvError('UNSUPPORTED', `${this.name} does not support input injection`)
    await this.call('sys.input', { actions }, undefined, opts.signal)
  }

  async closeTransport() {
    this.client.close()
    await this.onCloseHook?.()
  }
}

export function normalizeInfo(info) {
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
