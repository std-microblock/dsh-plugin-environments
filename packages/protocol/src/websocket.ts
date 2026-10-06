// Minimal WebSocket (RFC 6455) transport for the protocol: binary frames carry one byte
// stream. Client side dials ws:// or wss:// (TLS from Node); server side handles an HTTP
// `upgrade` event.
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import type { Duplex } from 'node:stream'
import type { Transport } from './client.ts'
import { EnvError } from './errors.ts'
import { CallbackTransport } from './transports.ts'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_PAYLOAD = 16 * 1024 * 1024 + 64 * 1024
export const OP = { cont: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const

export function wsAcceptKey(key: string): string {
  return crypto
    .createHash('sha1')
    .update(key.trim() + GUID)
    .digest('base64')
}

/** Encode one final frame; clients pass `mask: true`. */
export function encodeWsFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const n = payload.length
  const lenBytes = n < 126 ? 0 : n <= 0xffff ? 2 : 8
  const head = Buffer.alloc(2 + lenBytes + (mask ? 4 : 0))
  head[0] = 0x80 | opcode
  const m = mask ? 0x80 : 0
  if (lenBytes === 0) head[1] = m | n
  else if (lenBytes === 2) {
    head[1] = m | 126
    head.writeUInt16BE(n, 2)
  } else {
    head[1] = m | 127
    head.writeBigUInt64BE(BigInt(n), 2)
  }
  if (!mask) return Buffer.concat([head, payload])
  const key = crypto.randomBytes(4)
  key.copy(head, 2 + lenBytes)
  const body = Buffer.allocUnsafe(n)
  for (let i = 0; i < n; i++) body[i] = (payload[i] ?? 0) ^ (key[i & 3] ?? 0)
  return Buffer.concat([head, body])
}

export interface WsFrame {
  fin: boolean
  opcode: number
  payload: Buffer
}

/** Incremental frame decoder. `expectMasked`: true on the server side. */
export class WsDecoder {
  private buf: Buffer = Buffer.alloc(0)
  private readonly expectMasked: boolean
  private readonly onFrame: (f: WsFrame) => void

  constructor(expectMasked: boolean, onFrame: (f: WsFrame) => void) {
    this.expectMasked = expectMasked
    this.onFrame = onFrame
  }

  push(data: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data
    for (;;) {
      const b = this.buf
      if (b.length < 2) return
      const b0 = b[0] ?? 0
      const b1 = b[1] ?? 0
      if (b0 & 0x70) throw new EnvError('PROTOCOL', 'reserved websocket bits set')
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      if (masked !== this.expectMasked)
        throw new EnvError('PROTOCOL', masked ? 'server frames must not be masked' : 'client frames must be masked')
      let len = b1 & 0x7f
      let off = 2
      if (len === 126) {
        if (b.length < 4) return
        len = b.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (b.length < 10) return
        const big = b.readBigUInt64BE(2)
        if (big > BigInt(MAX_PAYLOAD)) throw new EnvError('PROTOCOL', 'websocket frame too large')
        len = Number(big)
        off = 10
      }
      if (len > MAX_PAYLOAD) throw new EnvError('PROTOCOL', 'websocket frame too large')
      if (opcode >= 8 && (len > 125 || !fin)) throw new EnvError('PROTOCOL', 'bad websocket control frame')
      const keyAt = off
      if (masked) off += 4
      if (b.length < off + len) return
      let payload = b.subarray(off, off + len)
      if (masked) {
        const out = Buffer.allocUnsafe(len)
        for (let i = 0; i < len; i++) out[i] = (payload[i] ?? 0) ^ (b[keyAt + (i & 3)] ?? 0)
        payload = out
      } else {
        payload = Buffer.from(payload)
      }
      this.buf = b.subarray(off + len)
      this.onFrame({ fin, opcode, payload })
    }
  }
}

/** Turn an upgraded socket into a byte-stream transport. */
function wsTransport(socket: Duplex, head: Buffer, isClient: boolean): Transport {
  let closed = false
  let sentClose = false
  const sendClose = () => {
    if (sentClose || socket.destroyed) return
    sentClose = true
    const code = Buffer.alloc(2)
    code.writeUInt16BE(1000)
    socket.write(encodeWsFrame(OP.close, code, isClient))
  }
  const t = new CallbackTransport({
    write: (data: Buffer) => socket.write(encodeWsFrame(OP.binary, data, isClient)),
    end: () => {
      sendClose()
      socket.end()
    },
    destroy: () => {
      sendClose()
      socket.destroy()
    },
  })
  const close = () => {
    if (closed) return
    closed = true
    t.emit('close')
  }
  const decoder = new WsDecoder(!isClient, f => {
    switch (f.opcode) {
      case OP.binary:
      case OP.cont:
        if (f.payload.length) t.push(f.payload)
        return
      case OP.ping:
        socket.write(encodeWsFrame(OP.pong, f.payload, isClient))
        return
      case OP.pong:
        return
      case OP.close:
        sendClose()
        socket.end()
        close()
        return
      default:
        throw new EnvError('PROTOCOL', 'text frames are not supported')
    }
  })
  const onData = (d: Buffer) => {
    if (closed) return
    try {
      decoder.push(d)
    } catch (e) {
      t.emit('error', e instanceof Error ? e : new EnvError('PROTOCOL', String(e)))
      socket.destroy()
      close()
    }
  }
  socket.on('data', onData)
  socket.on('close', close)
  socket.on('error', (e: Error) => {
    if (!closed) t.emit('error', e)
  })
  if (head.length) onData(head)
  return t
}

export interface WsConnectOptions {
  signal?: AbortSignal | undefined
  timeoutMs?: number
  headers?: Record<string, string>
}

/** Dial a ws:// or wss:// URL; resolves once the upgrade completed. */
export function wsConnect(
  url: string,
  { signal, timeoutMs = 15000, headers = {} }: WsConnectOptions = {},
): Promise<Transport> {
  const u = new URL(url)
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:')
    return Promise.reject(new EnvError('EINVAL', `not a websocket URL: ${url}`))
  const key = crypto.randomBytes(16).toString('base64')
  const mod = u.protocol === 'wss:' ? https : http
  return new Promise((resolve, reject) => {
    const req = mod.request({
      protocol: u.protocol === 'wss:' ? 'https:' : 'http:',
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || (u.protocol === 'wss:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers: {
        ...headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    })
    let done = false
    const finish = (e: Error | undefined, t?: Transport) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (e) {
        req.destroy()
        reject(e)
      } else if (t) resolve(t)
    }
    const timer = setTimeout(() => finish(new EnvError('ETIMEDOUT', `connecting to ${url} timed out`)), timeoutMs)
    const onAbort = () => finish(new EnvError('CANCELLED', 'aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('upgrade', (res, socket, head) => {
      if (res.headers['sec-websocket-accept'] !== wsAcceptKey(key)) {
        socket.destroy()
        finish(new EnvError('PROTOCOL', 'bad Sec-WebSocket-Accept'))
        return
      }
      if ('setNoDelay' in socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true)
      finish(undefined, wsTransport(socket, head, true))
    })
    req.on('response', res => {
      res.resume()
      finish(new EnvError('EIO', `websocket upgrade refused: HTTP ${String(res.statusCode)}`))
    })
    req.on('error', (e: NodeJS.ErrnoException) =>
      finish(new EnvError(e.code ?? 'EIO', `cannot connect to ${url}: ${e.message}`)),
    )
    req.end()
  })
}

/**
 * Complete a server-side upgrade from an `http.Server` `upgrade` event. Returns undefined (and
 * answers with an HTTP error) when the request is not a websocket upgrade.
 */
export function wsAccept(req: http.IncomingMessage, socket: Duplex, head: Buffer): Transport | undefined {
  const key = req.headers['sec-websocket-key']
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase()
  if (req.method !== 'GET' || upgrade !== 'websocket' || typeof key !== 'string') {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return undefined
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`,
  )
  return wsTransport(socket, head, false)
}
