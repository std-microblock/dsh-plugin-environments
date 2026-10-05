// Client for the dsh environment protocol (docs/protocol.md).
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

export const WINDOW = 1024 * 1024
export const CHUNK = 256 * 1024
const MAX_FRAME = 16 * 1024 * 1024 + 64 * 1024

/** Error raised for a failed protocol operation. */
export class EnvError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'EnvError'
    this.code = code
  }
}

export function encodeFrame(header, payload) {
  const h = Buffer.from(JSON.stringify(header), 'utf8')
  const p = payload ? Buffer.from(payload.buffer ?? payload, payload.byteOffset ?? 0, payload.byteLength ?? payload.length) : Buffer.alloc(0)
  const out = Buffer.allocUnsafe(8 + h.length + p.length)
  out.writeUInt32BE(4 + h.length + p.length, 0)
  out.writeUInt32BE(h.length, 4)
  h.copy(out, 8)
  p.copy(out, 8 + h.length)
  return out
}

/** Incremental frame decoder. */
export class FrameDecoder {
  constructor(onFrame) {
    this.onFrame = onFrame
    this.chunks = []
    this.length = 0
  }

  push(data) {
    this.chunks.push(data)
    this.length += data.length
    while (this.length >= 4) {
      const head = this.peek(4)
      const frameLen = head.readUInt32BE(0)
      if (frameLen < 4 || frameLen > MAX_FRAME) throw new EnvError('PROTOCOL', `bad frame length ${frameLen}`)
      if (this.length < 4 + frameLen) return
      const body = this.take(4 + frameLen).subarray(4)
      const headerLen = body.readUInt32BE(0)
      if (headerLen > frameLen - 4) throw new EnvError('PROTOCOL', 'bad header length')
      const header = JSON.parse(body.subarray(4, 4 + headerLen).toString('utf8'))
      this.onFrame(header, body.subarray(4 + headerLen))
    }
  }

  peek(n) {
    if (this.chunks[0].length >= n) return this.chunks[0].subarray(0, n)
    const merged = Buffer.concat(this.chunks)
    this.chunks = [merged]
    return merged.subarray(0, n)
  }

  take(n) {
    const merged = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks)
    const out = merged.subarray(0, n)
    const rest = merged.subarray(n)
    this.chunks = rest.length > 0 ? [rest] : []
    this.length -= n
    return out
  }
}

/** Credit-based send window for one (channel, fd) direction. */
class SendWindow {
  constructor() {
    this.credit = WINDOW
    this.waiters = []
    this.closed = false
  }

  add(n) {
    this.credit += n
    this.flush()
  }

  close() {
    this.closed = true
    this.flush()
  }

  flush() {
    while (this.waiters.length > 0 && (this.closed || this.credit >= this.waiters[0].n)) {
      const w = this.waiters.shift()
      if (!this.closed) this.credit -= w.n
      w.resolve(!this.closed)
    }
  }

  /** Resolve true once n bytes may be sent, false if the channel closed. */
  take(n) {
    if (this.closed) return Promise.resolve(false)
    if (this.waiters.length === 0 && this.credit >= n) {
      this.credit -= n
      return Promise.resolve(true)
    }
    return new Promise(resolve => this.waiters.push({ n, resolve }))
  }
}

/**
 * One multiplexed channel. Server→client data is exposed as Readable streams per fd;
 * client→server data as Writable streams per fd.
 */
export class Channel extends EventEmitter {
  constructor(client, ch) {
    super()
    this.client = client
    this.ch = ch
    this.closed = false
    this.readables = new Map()
    this.windows = new Map()
    this.closeResult = undefined
    this.closeError = undefined
    this.exit = undefined
    this.done = new Promise(resolve => { this._resolveDone = resolve })
  }

  /** Readable for server→client data on fd (default 1). */
  readable(fd = 1) {
    let r = this.readables.get(fd)
    if (r) return r
    let pending = 0
    r = new Readable({
      highWaterMark: 512 * 1024,
      read: () => {
        if (pending > 0 && !this.closed) {
          this.client.send({ t: 'win', ch: this.ch, ...this.fdField(fd, 1), n: pending })
          pending = 0
        }
      },
    })
    r._dshCredit = n => {
      if (r.readableFlowing !== false && r.readableLength < r.readableHighWaterMark) {
        if (!this.closed) this.client.send({ t: 'win', ch: this.ch, ...this.fdField(fd, 1), n })
      } else {
        pending += n
      }
    }
    this.readables.set(fd, r)
    return r
  }

  fdField(fd, defaultFd) {
    return fd === undefined || fd === defaultFd ? {} : { fd }
  }

  window(fd) {
    let w = this.windows.get(fd)
    if (!w) {
      w = new SendWindow()
      this.windows.set(fd, w)
    }
    return w
  }

  /** Send bytes to the server on fd (default 0), respecting flow control. */
  async write(data, fd = 0) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    for (let off = 0; off < buf.length; off += CHUNK) {
      const part = buf.subarray(off, Math.min(buf.length, off + CHUNK))
      if (!(await this.window(fd).take(part.length))) throw new EnvError('CLOSED', 'channel closed')
      this.client.send({ t: 'data', ch: this.ch, ...this.fdField(fd, 0) }, part)
    }
  }

  end(fd = 0) {
    if (!this.closed) this.client.send({ t: 'eof', ch: this.ch, ...this.fdField(fd, 0) })
  }

  /** Writable for client→server data on fd (default 0). */
  writable(fd = 0) {
    return new Writable({
      highWaterMark: 256 * 1024,
      write: (chunk, _enc, cb) => { this.write(chunk, fd).then(() => cb(), cb) },
      final: cb => { this.end(fd); cb() },
      destroy: (err, cb) => cb(err),
    })
  }

  /** Abort the channel from the client side. */
  close() {
    if (this.closed) return
    this.client.send({ t: 'close', ch: this.ch })
    this._closed(undefined, undefined)
  }

  _onFrame(header, payload) {
    switch (header.t) {
      case 'data': {
        const fd = header.fd ?? 1
        const r = this.readable(fd)
        // Copy: the payload is a view into a shared decode buffer.
        const copy = Buffer.from(payload)
        r.push(copy)
        r._dshCredit(copy.length)
        break
      }
      case 'eof':
        this.readable(header.fd ?? 1).push(null)
        break
      case 'win':
        this.window(header.fd ?? 0).add(header.n ?? 0)
        break
      case 'exit':
        this.exit = { code: header.code ?? null, signal: header.signal ?? null }
        this.emit('exit', this.exit)
        break
      case 'close':
        this._closed(header.result, header.error ? new EnvError(header.error.code, header.error.message) : undefined)
        break
    }
  }

  _closed(result, error) {
    if (this.closed) return
    this.closed = true
    this.closeResult = result
    this.closeError = error
    for (const w of this.windows.values()) w.close()
    for (const r of this.readables.values()) {
      if (!r.readableEnded) {
        if (error) r.destroy(error)
        else r.push(null)
      }
    }
    this.client.channels.delete(this.ch)
    this.emit('close', { result, error })
    this._resolveDone({ result, error })
  }
}

/**
 * A protocol connection over a duplex byte transport.
 * `transport` = { write(buf), end(), on('data'), on('close'), destroy() } – e.g. a net.Socket,
 * or an adapter around a child process's stdin/stdout.
 */
export class EnvClient extends EventEmitter {
  constructor(transport, { token = '', pingMs = 15000 } = {}) {
    super()
    this.transport = transport
    this.token = token
    this.pingMs = pingMs
    this.nextId = 1
    this.pending = new Map()
    this.channels = new Map()
    this.earlyFrames = new Map()
    this.listeners_ = new Map()
    this.closed = false
    this.info = undefined
    this.decoder = new FrameDecoder((h, p) => this.onFrame(h, p))
    this._hello = new Promise((resolve, reject) => { this._helloResolve = resolve; this._helloReject = reject })
    this._hello.catch(() => {})
    transport.on('data', data => {
      try {
        this.decoder.push(data)
      } catch (error) {
        this.fail(error)
      }
    })
    transport.on('close', () => this.fail(new EnvError('CLOSED', 'connection closed')))
    transport.on('error', error => this.fail(error))
  }

  /** Perform the handshake; resolves to the server Info. */
  async connect(signal) {
    this.send({ t: 'hello', v: 1, token: this.token, client: 'dsh-plugin-environments/0.1.0' })
    const onAbort = () => this.fail(new EnvError('CANCELLED', 'connect aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      this.info = await this._hello
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    if (this.pingMs > 0) {
      let n = 0
      this.pingTimer = setInterval(() => this.send({ t: 'ping', n: ++n }), this.pingMs)
      this.pingTimer.unref?.()
    }
    return this.info
  }

  send(header, payload) {
    if (this.closed) return
    try {
      this.transport.write(encodeFrame(header, payload))
    } catch (error) {
      this.fail(error)
    }
  }

  onFrame(header, payload) {
    switch (header.t) {
      case 'hello':
        if (header.ok) this._helloResolve(header.info)
        else this._helloReject(new EnvError(header.error?.code ?? 'AUTH', header.error?.message ?? 'handshake rejected'))
        return
      case 'res': {
        const p = this.pending.get(header.id)
        if (!p) return
        this.pending.delete(header.id)
        if (header.ok) p.resolve({ result: header.result, payload: Buffer.from(payload) })
        else p.reject(new EnvError(header.error?.code ?? 'EIO', header.error?.message ?? 'operation failed'))
        return
      }
      case 'ping':
        this.send({ t: 'pong', n: header.n })
        return
      case 'pong':
        return
      case 'accept': {
        const ch = this.channel(header.ch)
        this.emit('accept', { listener: header.listener, ch, peer: header.peer })
        const l = this.listeners_.get(header.listener)
        if (l) l(ch, header.peer)
        return
      }
      default: {
        if (header.ch === undefined) return
        const ch = this.channels.get(header.ch)
        if (ch) ch._onFrame(header, payload)
        else {
          // Frames can arrive before the response that announces the channel.
          let q = this.earlyFrames.get(header.ch)
          if (!q) this.earlyFrames.set(header.ch, q = [])
          q.push([header, Buffer.from(payload)])
        }
      }
    }
  }

  /** Get or create the client half of a server-allocated channel. */
  channel(id) {
    let ch = this.channels.get(id)
    if (ch) return ch
    ch = new Channel(this, id)
    this.channels.set(id, ch)
    const early = this.earlyFrames.get(id)
    if (early) {
      this.earlyFrames.delete(id)
      for (const [h, p] of early) ch._onFrame(h, p)
    }
    return ch
  }

  /** Issue a request. Resolves to { result, payload }. */
  request(op, args = {}, payload, signal) {
    if (this.closed) return Promise.reject(this.closeError ?? new EnvError('CLOSED', 'connection closed'))
    if (signal?.aborted) return Promise.reject(new EnvError('CANCELLED', 'aborted'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.has(id)) return
        this.send({ t: 'cancel', id })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: v => { signal?.removeEventListener('abort', onAbort); resolve(v) },
        reject: e => { signal?.removeEventListener('abort', onAbort); reject(e) },
      })
      this.send({ t: 'req', id, op, args }, payload)
    })
  }

  async call(op, args, payload, signal) {
    return (await this.request(op, args, payload, signal)).result
  }

  onListener(id, fn) {
    this.listeners_.set(id, fn)
    return () => this.listeners_.delete(id)
  }

  fail(error) {
    if (this.closed) return
    this.closed = true
    this.closeError = error
    clearInterval(this.pingTimer)
    this._helloReject(error)
    for (const p of this.pending.values()) p.reject(error instanceof EnvError ? error : new EnvError('CLOSED', String(error?.message ?? error)))
    this.pending.clear()
    for (const ch of [...this.channels.values()]) ch._closed(undefined, new EnvError('CLOSED', 'connection closed'))
    try { this.transport.destroy?.() } catch {}
    this.emit('close', error)
  }

  close() {
    if (this.closed) return
    try { this.transport.end?.() } catch {}
    this.fail(new EnvError('CLOSED', 'connection closed by client'))
  }
}

/** Adapt a child process (stdio mode server) to the transport interface. */
export function childTransport(child) {
  const t = new EventEmitter()
  child.stdout.on('data', d => t.emit('data', d))
  child.on('exit', () => t.emit('close'))
  child.on('error', e => t.emit('error', e))
  child.stdin.on('error', () => {})
  t.write = buf => child.stdin.write(buf)
  t.end = () => child.stdin.end()
  t.destroy = () => { try { child.stdin.end() } catch {} ; setTimeout(() => { try { child.kill() } catch {} }, 2000).unref?.() }
  return t
}
