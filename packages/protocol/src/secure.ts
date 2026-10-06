// Secure channel for network transports (docs/protocol.md, "Secure channel"): a pre-shared
// secret authenticates both peers and keys a ChaCha20-Poly1305 record layer.
import crypto from 'node:crypto'
import type { Transport } from './client.ts'
import { EnvError } from './errors.ts'
import { CallbackTransport } from './transports.ts'

export const SECURE_MAGIC = Buffer.from('DSHS')
export const SECURE_VERSION = 1
/** Largest plaintext carried by one record. */
export const MAX_RECORD = 64 * 1024
const TAG = 16
const INFO = Buffer.from('dsh-env secure v1\0')
const HANDSHAKE_TIMEOUT_MS = 15000

/** Per-connection key material. */
export interface SecureKeys {
  i2r: Buffer
  r2i: Buffer
  confirmI: Buffer
  confirmR: Buffer
}

/** Derive the keys; `transcript` is the initiator hello followed by the responder's magic, version and nonce. */
export function deriveKeys(
  secret: Buffer | string,
  nonceI: Buffer,
  nonceR: Buffer,
  id: Buffer | string,
  transcript: Buffer,
): SecureKeys {
  const okm = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(secret),
      Buffer.concat([nonceI, nonceR]),
      Buffer.concat([INFO, Buffer.from(id)]),
      128,
    ),
  )
  const th = crypto.createHash('sha256').update(transcript).digest()
  const mac = (key: Buffer, label: string) => crypto.createHmac('sha256', key).update(label).update(th).digest()
  return {
    i2r: okm.subarray(0, 32),
    r2i: okm.subarray(32, 64),
    confirmI: mac(okm.subarray(64, 96), 'initiator'),
    confirmR: mac(okm.subarray(96, 128), 'responder'),
  }
}

/** One direction of the record layer; the record sequence number is the nonce. */
export class RecordCipher {
  private readonly key: Buffer
  private seq = 0n

  constructor(key: Buffer) {
    this.key = key
  }

  private nonce(): Buffer {
    const n = Buffer.alloc(12)
    n.writeBigUInt64BE(this.seq, 4)
    this.seq++
    return n
  }

  /** Encrypt one record (`plain.length <= MAX_RECORD`) into its wire bytes. */
  seal(plain: Buffer): Buffer {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(plain.length + TAG)
    const c = crypto.createCipheriv('chacha20-poly1305', this.key, this.nonce(), { authTagLength: TAG })
    c.setAAD(len)
    return Buffer.concat([len, c.update(plain), c.final(), c.getAuthTag()])
  }

  /** Decrypt one record body (ciphertext || tag) whose length prefix is `len`. */
  open(len: Buffer, body: Buffer): Buffer {
    if (body.length < TAG) throw new EnvError('PROTOCOL', 'short record')
    const d = crypto.createDecipheriv('chacha20-poly1305', this.key, this.nonce(), { authTagLength: TAG })
    d.setAAD(len)
    d.setAuthTag(body.subarray(body.length - TAG))
    try {
      return Buffer.concat([d.update(body.subarray(0, body.length - TAG)), d.final()])
    } catch {
      throw new EnvError('PROTOCOL', 'record authentication failed')
    }
  }
}

/** Pull-style reader over a push-style transport, used during the handshake. */
class HandshakeReader {
  private buf: Buffer = Buffer.alloc(0)
  private want: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | undefined
  private ended: Error | undefined
  private readonly offData: () => void

  constructor(transport: Transport) {
    let active = true
    const onData = (d: Buffer) => {
      if (!active) return
      this.buf = Buffer.concat([this.buf, d])
      this.pump()
    }
    const onEnd = (e?: Error) => {
      if (!active) return
      this.ended =
        e ?? new EnvError('AUTH', 'peer closed the connection during the handshake (unknown id or wrong secret?)')
      this.pump()
    }
    transport.on('data', onData)
    transport.on('close', () => onEnd())
    transport.on('error', e => onEnd(e))
    this.offData = () => {
      active = false
    }
  }

  private pump(): void {
    const w = this.want
    if (!w) return
    if (this.buf.length >= w.n) {
      this.want = undefined
      const out = this.buf.subarray(0, w.n)
      this.buf = this.buf.subarray(w.n)
      w.resolve(out)
    } else if (this.ended) {
      this.want = undefined
      w.reject(this.ended)
    }
  }

  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.want = { n, resolve, reject }
      this.pump()
    })
  }

  /** Stop listening and return bytes received past the handshake. */
  detach(): Buffer {
    this.offData()
    return this.buf
  }
}

function withTimeout<T>(p: Promise<T>, transport: Transport, signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = (e: Error) => {
      cleanup()
      try {
        transport.destroy?.()
      } catch {
        // already gone
      }
      reject(e)
    }
    const timer = setTimeout(() => fail(new EnvError('ETIMEDOUT', 'secure handshake timed out')), HANDSHAKE_TIMEOUT_MS)
    const onAbort = () => fail(new EnvError('CANCELLED', 'aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    p.then(
      v => {
        cleanup()
        resolve(v)
      },
      (e: unknown) => fail(e instanceof Error ? e : new EnvError('EIO', String(e))),
    )
  })
}

/** Wrap an authenticated transport in the record layer. */
function recordTransport(inner: Transport, leftover: Buffer, rx: RecordCipher, tx: RecordCipher): Transport {
  let closed = false
  const out = new CallbackTransport({
    write: (data: Buffer) => {
      for (let i = 0; i < data.length; i += MAX_RECORD) inner.write(tx.seal(data.subarray(i, i + MAX_RECORD)))
      return true
    },
    end: () => inner.end?.(),
    destroy: () => inner.destroy?.(),
  })
  const close = () => {
    if (closed) return
    closed = true
    out.emit('close')
  }
  const deliver = (plain: Buffer) => out.push(plain)
  let buf: Buffer = Buffer.alloc(0)
  const onData = (d: Buffer) => {
    if (closed) return
    buf = buf.length ? Buffer.concat([buf, d]) : d
    try {
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0)
        if (n < TAG || n > MAX_RECORD + TAG) throw new EnvError('PROTOCOL', 'bad record length')
        if (buf.length < 4 + n) break
        const plain = rx.open(buf.subarray(0, 4), buf.subarray(4, 4 + n))
        buf = buf.subarray(4 + n)
        if (plain.length) deliver(plain)
      }
    } catch (e) {
      out.emit('error', e instanceof Error ? e : new EnvError('PROTOCOL', String(e)))
      try {
        inner.destroy?.()
      } catch {
        // already gone
      }
      close()
    }
  }
  inner.on('data', onData)
  inner.on('close', close)
  inner.on('error', e => {
    if (!closed) out.emit('error', e)
  })
  if (leftover.length) onData(leftover)
  return out
}

export interface InitiateOptions {
  secret: string
  /** Identifies the initiator (its environment id on reverse connections); may be empty. */
  id?: string
  signal?: AbortSignal | undefined
}

/** Run the initiator side of the secure handshake; resolves to the encrypted transport. */
export function secureInitiate(transport: Transport, { secret, id = '', signal }: InitiateOptions): Promise<Transport> {
  const reader = new HandshakeReader(transport)
  const idBytes = Buffer.from(id)
  if (idBytes.length > 255) return Promise.reject(new EnvError('EINVAL', 'id too long'))
  const nonceI = crypto.randomBytes(32)
  const hello = Buffer.concat([
    SECURE_MAGIC,
    Buffer.from([SECURE_VERSION]),
    nonceI,
    Buffer.from([idBytes.length]),
    idBytes,
  ])
  const run = async () => {
    transport.write(hello)
    const reply = await reader.read(69)
    if (!reply.subarray(0, 4).equals(SECURE_MAGIC) || reply[4] !== SECURE_VERSION)
      throw new EnvError('PROTOCOL', 'peer does not speak the dsh-env secure channel')
    const keys = deriveKeys(
      secret,
      nonceI,
      reply.subarray(5, 37),
      idBytes,
      Buffer.concat([hello, reply.subarray(0, 37)]),
    )
    if (!crypto.timingSafeEqual(keys.confirmR, reply.subarray(37, 69)))
      throw new EnvError('AUTH', 'peer failed to prove knowledge of the secret (wrong secret?)')
    transport.write(keys.confirmI)
    return recordTransport(transport, reader.detach(), new RecordCipher(keys.r2i), new RecordCipher(keys.i2r))
  }
  return withTimeout(run(), transport, signal)
}

/** Run the responder side; `lookup` maps the initiator's id to its secret (undefined = reject). */
export function secureRespond(
  transport: Transport,
  lookup: (id: string) => string | undefined,
): Promise<{ transport: Transport; id: string }> {
  const reader = new HandshakeReader(transport)
  const run = async () => {
    const head = await reader.read(38)
    if (!head.subarray(0, 4).equals(SECURE_MAGIC)) throw new EnvError('PROTOCOL', 'not a dsh-env secure channel')
    if (head[4] !== SECURE_VERSION) throw new EnvError('PROTOCOL', 'unsupported secure channel version')
    const idBytes = await reader.read(head[37] ?? 0)
    const id = idBytes.toString('utf8')
    const secret = lookup(id)
    if (secret === undefined) throw new EnvError('AUTH', `unknown id "${id}"`)
    const nonceR = crypto.randomBytes(32)
    const replyHead = Buffer.concat([SECURE_MAGIC, Buffer.from([SECURE_VERSION]), nonceR])
    const keys = deriveKeys(secret, head.subarray(5, 37), nonceR, idBytes, Buffer.concat([head, idBytes, replyHead]))
    transport.write(Buffer.concat([replyHead, keys.confirmR]))
    const confirm = await reader.read(32)
    if (!crypto.timingSafeEqual(keys.confirmI, confirm))
      throw new EnvError('AUTH', 'client failed to prove knowledge of the secret')
    return {
      transport: recordTransport(transport, reader.detach(), new RecordCipher(keys.i2r), new RecordCipher(keys.r2i)),
      id,
    }
  }
  return withTimeout(run(), transport, undefined)
}

/** A fresh high-entropy secret (256 bits, base64url). */
export function generateSecret(): string {
  return crypto.randomBytes(32).toString('base64url')
}
