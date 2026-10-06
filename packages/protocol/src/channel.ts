// Multiplexed channels with credit-based flow control.
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { EnvError } from './errors.ts'
import { CHUNK, WINDOW, type ChannelHeader, type ExitInfo, type OutgoingHeader } from './types.ts'

/** The part of the connection a channel needs. */
export interface ChannelHost {
  send(header: OutgoingHeader, payload?: ArrayBufferView): void
  forgetChannel(ch: number): void
}

/** Outcome of a channel: the server's `close` result or the error that ended it. */
export interface ChannelOutcome {
  result: unknown
  error: EnvError | undefined
}

interface Waiter {
  n: number
  resolve: (ok: boolean) => void
}

/** Credit-based send window for one (channel, fd) direction. */
class SendWindow {
  private credit = WINDOW
  private readonly waiters: Waiter[] = []
  private closed = false

  add(n: number): void {
    this.credit += n
    this.flush()
  }

  close(): void {
    this.closed = true
    this.flush()
  }

  private flush(): void {
    let w = this.waiters[0]
    while (w && (this.closed || this.credit >= w.n)) {
      this.waiters.shift()
      if (!this.closed) this.credit -= w.n
      w.resolve(!this.closed)
      w = this.waiters[0]
    }
  }

  /** Resolve true once n bytes may be sent, false if the channel closed. */
  take(n: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    if (this.waiters.length === 0 && this.credit >= n) {
      this.credit -= n
      return Promise.resolve(true)
    }
    return new Promise(resolve => this.waiters.push({ n, resolve }))
  }
}

/** Readable that grants window credit back to the server as the application consumes data. */
interface CreditReadable extends Readable {
  dshCredit(n: number): void
}

export interface ChannelEvents {
  exit: [ExitInfo]
  close: [ChannelOutcome]
}

/**
 * One multiplexed channel. Server→client data is exposed as Readable streams per fd;
 * client→server data as Writable streams per fd.
 */
export class Channel extends EventEmitter<ChannelEvents> {
  readonly host: ChannelHost
  readonly ch: number
  closed = false
  closeResult: unknown = undefined
  closeError: EnvError | undefined = undefined
  exit: ExitInfo | undefined = undefined
  readonly done: Promise<ChannelOutcome>
  private readonly readables = new Map<number, CreditReadable>()
  private readonly windows = new Map<number, SendWindow>()
  private resolveDone!: (outcome: ChannelOutcome) => void

  constructor(host: ChannelHost, ch: number) {
    super()
    this.host = host
    this.ch = ch
    this.done = new Promise(resolve => {
      this.resolveDone = resolve
    })
  }

  /** Readable for server→client data on fd (default 1). */
  readable(fd = 1): Readable {
    return this.creditReadable(fd)
  }

  private creditReadable(fd: number): CreditReadable {
    const existing = this.readables.get(fd)
    if (existing) return existing
    let pending = 0
    const r = new Readable({
      highWaterMark: 512 * 1024,
      read: () => {
        if (pending > 0 && !this.closed) {
          this.host.send({ t: 'win', ch: this.ch, ...fdField(fd, 1), n: pending })
          pending = 0
        }
      },
    }) as CreditReadable
    r.dshCredit = n => {
      if (r.readableFlowing !== false && r.readableLength < r.readableHighWaterMark) {
        if (!this.closed) this.host.send({ t: 'win', ch: this.ch, ...fdField(fd, 1), n })
      } else {
        pending += n
      }
    }
    this.readables.set(fd, r)
    return r
  }

  private window(fd: number): SendWindow {
    let w = this.windows.get(fd)
    if (!w) {
      w = new SendWindow()
      this.windows.set(fd, w)
    }
    return w
  }

  /** Send bytes to the server on fd (default 0), respecting flow control. */
  async write(data: Uint8Array | string, fd = 0): Promise<void> {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    for (let off = 0; off < buf.length; off += CHUNK) {
      const part = buf.subarray(off, Math.min(buf.length, off + CHUNK))
      if (!(await this.window(fd).take(part.length))) throw new EnvError('CLOSED', 'channel closed')
      this.host.send({ t: 'data', ch: this.ch, ...fdField(fd, 0) }, part)
    }
  }

  end(fd = 0): void {
    if (!this.closed) this.host.send({ t: 'eof', ch: this.ch, ...fdField(fd, 0) })
  }

  /** Writable for client→server data on fd (default 0). */
  writable(fd = 0): Writable {
    return new Writable({
      highWaterMark: 256 * 1024,
      write: (chunk: Buffer, _enc, cb) => {
        this.write(chunk, fd).then(() => cb(), cb)
      },
      final: cb => {
        this.end(fd)
        cb()
      },
      destroy: (err, cb) => cb(err),
    })
  }

  /** Abort the channel from the client side. */
  close(): void {
    if (this.closed) return
    this.host.send({ t: 'close', ch: this.ch })
    this.markClosed(undefined, undefined)
  }

  /** Deliver one frame addressed to this channel. */
  handleFrame(header: ChannelHeader, payload: Buffer): void {
    switch (header.t) {
      case 'data': {
        const r = this.creditReadable(header.fd ?? 1)
        // Copy: the payload is a view into a shared decode buffer.
        const copy = Buffer.from(payload)
        r.push(copy)
        r.dshCredit(copy.length)
        break
      }
      case 'eof':
        this.creditReadable(header.fd ?? 1).push(null)
        break
      case 'win':
        this.window(header.fd ?? 0).add(header.n ?? 0)
        break
      case 'exit':
        this.exit = { code: header.code ?? null, signal: header.signal ?? null }
        this.emit('exit', this.exit)
        break
      case 'close':
        this.markClosed(header.result, header.error ? new EnvError(header.error.code, header.error.message) : undefined)
        break
    }
  }

  /** Mark the channel closed (by the server, the client or a lost connection). */
  markClosed(result: unknown, error: EnvError | undefined): void {
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
    this.host.forgetChannel(this.ch)
    this.emit('close', { result, error })
    this.resolveDone({ result, error })
  }
}

function fdField(fd: number, defaultFd: number): { fd?: number } {
  return fd === defaultFd ? {} : { fd }
}
