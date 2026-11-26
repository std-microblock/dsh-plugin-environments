// Image results of the MCP tools: the shared tool bodies hand images to an attachment store, so
// this in-memory store is what turns them into MCP `image` content blocks (base64 + media type).
import { isPng, pngSize } from '../image/codec.ts'
import type { AttachmentStore, SavedImage } from '../host-api.ts'

interface StoredImage {
  data: Buffer
  mediaType: string
  name: string
  width: number
  height: number
}

/** Size of a JPEG image from its SOF marker; `undefined` when the stream is not readable as one. */
function jpegSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1] ?? 0
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const length = buf.readUInt16BE(i + 2)
    // SOF0..SOF15 frame headers (C4 = DHT, C8 = JPG, CC = DAC are not frame headers).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    if (length < 2) return undefined
    i += 2 + length
  }
  return undefined
}

/** Size of a GIF/WebP image, else `undefined`. */
function otherSize(buf: Buffer): { width: number; height: number } | undefined {
  const ascii = (start: number, end: number) => buf.toString('latin1', start, end)
  if (buf.length > 10 && ascii(0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  if (buf.length > 30 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const kind = ascii(12, 16)
    if (kind === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 }
    if (kind === 'VP8L') {
      const bits = buf.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (kind === 'VP8 ' && buf.length > 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a)
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  return undefined
}

/** Image size for the note in a tool result; 0x0 when the format is unknown. */
export function imageSize(buf: Uint8Array, mediaType?: string): { width: number; height: number } {
  const bytes = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (isPng(bytes)) {
    try {
      return pngSize(bytes)
    } catch {
      // fall through to the other readers
    }
  }
  const size = (mediaType === 'image/gif' ? undefined : jpegSize(bytes)) ?? otherSize(bytes)
  return size ?? { width: 0, height: 0 }
}

/** Attachment store keeping images in memory, addressed by the ids the tool results report. */
export class MemoryAttachments implements AttachmentStore {
  private readonly images = new Map<string, StoredImage>()
  private seq = 0

  async saveImage({
    data,
    mediaType,
    name,
  }: {
    data: Uint8Array
    mediaType: string
    name: string
  }): Promise<SavedImage> {
    const id = `image-${++this.seq}`
    const bytes = Buffer.from(data)
    const { width, height } = imageSize(bytes, mediaType)
    this.images.set(id, { data: bytes, mediaType, name, width, height })
    return { attachmentId: id, mediaType, bytes: bytes.length, width, height, name }
  }

  /** The stored bytes of an image result, or undefined once it was taken. */
  take(id: string): StoredImage | undefined {
    return this.images.get(id)
  }

  /** Drop every stored image (called once a call's result was written). */
  clear(): void {
    this.images.clear()
  }

  get size(): number {
    return this.images.size
  }
}
