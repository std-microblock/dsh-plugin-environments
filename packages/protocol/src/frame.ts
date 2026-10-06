// Length-prefixed frame encoding: u32 frameLen, u32 headerLen, JSON header, binary payload.
import { EnvError } from './errors.ts'
import { MAX_FRAME, type FrameHeader } from './types.ts'

/** Encode one frame. `payload` may be any byte view. */
export function encodeFrame(header: object, payload?: ArrayBufferView | ArrayBuffer): Buffer {
  const h = Buffer.from(JSON.stringify(header), 'utf8')
  const p = toBuffer(payload)
  const out = Buffer.allocUnsafe(8 + h.length + p.length)
  out.writeUInt32BE(4 + h.length + p.length, 0)
  out.writeUInt32BE(h.length, 4)
  h.copy(out, 8)
  p.copy(out, 8 + h.length)
  return out
}

function toBuffer(payload: ArrayBufferView | ArrayBuffer | undefined): Buffer {
  if (!payload) return Buffer.alloc(0)
  if (payload instanceof ArrayBuffer) return Buffer.from(payload)
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
}

export type FrameHandler = (header: FrameHeader, payload: Buffer) => void

/** Incremental frame decoder. `onFrame` receives a payload view into a shared buffer; copy it to keep it. */
export class FrameDecoder {
  private chunks: Buffer[] = []
  private length = 0
  private readonly onFrame: FrameHandler

  constructor(onFrame: FrameHandler) {
    this.onFrame = onFrame
  }

  push(data: Buffer): void {
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
      const header = JSON.parse(body.subarray(4, 4 + headerLen).toString('utf8')) as FrameHeader
      this.onFrame(header, body.subarray(4 + headerLen))
    }
  }

  private peek(n: number): Buffer {
    const first = this.chunks[0]
    if (first && first.length >= n) return first.subarray(0, n)
    const merged = Buffer.concat(this.chunks)
    this.chunks = [merged]
    return merged.subarray(0, n)
  }

  private take(n: number): Buffer {
    const merged = this.chunks.length === 1 && this.chunks[0] ? this.chunks[0] : Buffer.concat(this.chunks)
    const out = merged.subarray(0, n)
    const rest = merged.subarray(n)
    this.chunks = rest.length > 0 ? [rest] : []
    this.length -= n
    return out
  }
}
