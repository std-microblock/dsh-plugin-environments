// Client side of one dsh environment protocol connection (docs/protocol.md).
import { EventEmitter } from 'node:events'
import { Channel, type ChannelHost } from './channel.ts'
import { EnvError, errorMessage } from './errors.ts'
import { encodeFrame, FrameDecoder } from './frame.ts'
import {
  CLIENT_ID,
  PROTOCOL_VERSION,
  type AcceptHeader,
  type ChannelHeader,
  type FrameHeader,
  type HelloResponse,
  type Info,
  type Op,
  type OpArgs,
  type OpResult,
  type OutgoingHeader,
  type PingHeader,
  type ResponseHeader,
} from './types.ts'

/**
 * Duplex byte transport carrying one connection: a `net.Socket`, an SSH exec stream,
 * or an adapter around a child process's stdin/stdout (see {@link childTransport}).
 */
export interface Transport {
  write(data: Buffer): unknown
  end?(): unknown
  destroy?(): unknown
  on(event: 'data', listener: (data: Buffer) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface EnvClientOptions {
  /** Shared secret for servers started with `--token`. */
  token?: string
  /** Keepalive ping interval; 0 disables pings. */
  pingMs?: number
}

/** A response: the JSON result plus the binary payload (possibly empty). */
export interface Response<O extends Op> {
  result: OpResult<O>
  payload: Buffer
}

interface Pending {
  resolve: (value: { result: unknown; payload: Buffer }) => void
  reject: (error: Error) => void
}

export interface AcceptEvent {
  listener: number
  ch: Channel
  peer: string
}

export interface EnvClientEvents {
  accept: [AcceptEvent]
  close: [Error]
}

/** Handler for connections accepted by one `net.listen` listener. */
export type ListenerHandler = (channel: Channel, peer: string) => void

/** A protocol connection over a duplex byte transport. */
export class EnvClient extends EventEmitter<EnvClientEvents> implements ChannelHost {
  readonly transport: Transport
  readonly token: string
  readonly pingMs: number
  closed = false
  closeError: Error | undefined = undefined
  info: Partial<Info> | undefined = undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly channels = new Map<number, Channel>()
  private readonly earlyFrames = new Map<number, [ChannelHeader, Buffer][]>()
  private readonly listenerHandlers = new Map<number, ListenerHandler>()
  private readonly decoder: FrameDecoder
  private readonly hello: Promise<Partial<Info>>
  private helloResolve!: (info: Partial<Info>) => void
  private helloReject!: (error: Error) => void
  private pingTimer: NodeJS.Timeout | undefined

  constructor(transport: Transport, { token = '', pingMs = 15000 }: EnvClientOptions = {}) {
    super()
    this.transport = transport
    this.token = token
    this.pingMs = pingMs
    this.decoder = new FrameDecoder((h, p) => this.onFrame(h, p))
    this.hello = new Promise((resolve, reject) => {
      this.helloResolve = resolve
      this.helloReject = reject
    })
    this.hello.catch(() => {})
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

  /** Perform the handshake; resolves to the (raw) server Info. */
  async connect(signal?: AbortSignal): Promise<Partial<Info>> {
    this.send({ t: 'hello', v: PROTOCOL_VERSION, token: this.token, client: CLIENT_ID })
    const onAbort = () => this.fail(new EnvError('CANCELLED', 'connect aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    let info: Partial<Info>
    try {
      info = await this.hello
      this.info = info
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    if (this.pingMs > 0) {
      let n = 0
      this.pingTimer = setInterval(() => this.send({ t: 'ping', n: ++n }), this.pingMs)
      this.pingTimer.unref()
    }
    return info
  }

  send(header: OutgoingHeader, payload?: ArrayBufferView): void {
    if (this.closed) return
    try {
      this.transport.write(encodeFrame(header, payload))
    } catch (error) {
      this.fail(error)
    }
  }

  forgetChannel(ch: number): void {
    this.channels.delete(ch)
  }

  private onFrame(header: FrameHeader, payload: Buffer): void {
    switch (header.t) {
      case 'hello': {
        const h = header as unknown as HelloResponse
        if (h.ok) this.helloResolve(h.info)
        else this.helloReject(new EnvError(h.error?.code ?? 'AUTH', h.error?.message ?? 'handshake rejected'))
        return
      }
      case 'res': {
        const h = header as unknown as ResponseHeader
        const p = this.pending.get(h.id)
        if (!p) return
        this.pending.delete(h.id)
        if (h.ok) p.resolve({ result: h.result, payload: Buffer.from(payload) })
        else p.reject(new EnvError(h.error?.code ?? 'EIO', h.error?.message ?? 'operation failed'))
        return
      }
      case 'ping':
        this.send({ t: 'pong', n: (header as unknown as PingHeader).n })
        return
      case 'pong':
        return
      case 'accept': {
        const h = header as unknown as AcceptHeader
        const ch = this.channel(h.ch)
        this.emit('accept', { listener: h.listener, ch, peer: h.peer })
        this.listenerHandlers.get(h.listener)?.(ch, h.peer)
        return
      }
      default: {
        const h = header as unknown as ChannelHeader
        if (h.ch === undefined) return
        const ch = this.channels.get(h.ch)
        if (ch) ch.handleFrame(h, payload)
        else {
          // Frames can arrive before the response that announces the channel.
          let q = this.earlyFrames.get(h.ch)
          if (!q) this.earlyFrames.set(h.ch, (q = []))
          q.push([h, Buffer.from(payload)])
        }
      }
    }
  }

  /** Get or create the client half of a server-allocated channel. */
  channel(id: number): Channel {
    const existing = this.channels.get(id)
    if (existing) return existing
    const ch = new Channel(this, id)
    this.channels.set(id, ch)
    const early = this.earlyFrames.get(id)
    if (early) {
      this.earlyFrames.delete(id)
      for (const [h, p] of early) ch.handleFrame(h, p)
    }
    return ch
  }

  /** Issue a request. Resolves to `{ result, payload }`. */
  request<O extends Op>(op: O, args: OpArgs<O>, payload?: ArrayBufferView, signal?: AbortSignal): Promise<Response<O>> {
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
        resolve: v => {
          signal?.removeEventListener('abort', onAbort)
          // The server is trusted to answer with the shape documented for `op`.
          resolve(v as Response<O>)
        },
        reject: e => {
          signal?.removeEventListener('abort', onAbort)
          reject(e)
        },
      })
      this.send({ t: 'req', id, op, args }, payload)
    })
  }

  /** Issue a request and return only its JSON result. */
  async call<O extends Op>(
    op: O,
    args: OpArgs<O>,
    payload?: ArrayBufferView,
    signal?: AbortSignal,
  ): Promise<OpResult<O>> {
    return (await this.request(op, args, payload, signal)).result
  }

  /** Route connections accepted by listener `id` to `fn`. Returns an unsubscribe function. */
  onListener(id: number, fn: ListenerHandler): () => void {
    this.listenerHandlers.set(id, fn)
    return () => this.listenerHandlers.delete(id)
  }

  /** Tear the connection down with `error`, failing every pending request and channel. */
  fail(error: unknown): void {
    if (this.closed) return
    const err = error instanceof Error ? error : new EnvError('CLOSED', errorMessage(error))
    this.closed = true
    this.closeError = err
    clearInterval(this.pingTimer)
    this.helloReject(err)
    for (const p of this.pending.values()) p.reject(err instanceof EnvError ? err : new EnvError('CLOSED', err.message))
    this.pending.clear()
    for (const ch of [...this.channels.values()]) ch.markClosed(undefined, new EnvError('CLOSED', 'connection closed'))
    try {
      this.transport.destroy?.()
    } catch {
      // already gone
    }
    this.emit('close', err)
  }

  close(): void {
    if (this.closed) return
    try {
      this.transport.end?.()
    } catch {
      // already gone
    }
    this.fail(new EnvError('CLOSED', 'connection closed by client'))
  }
}
