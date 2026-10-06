// Dependency-free image helpers for screenshots: PNG decode/encode, crop, area resize, JPEG encode.
import zlib from 'node:zlib'
import type { PixelRect } from '@dsh-environments/protocol'
import { encodeJpeg } from './jpeg.ts'

/** 8-bit RGB pixels, row-major without padding. */
export interface RgbImage {
  width: number
  height: number
  data: Uint8Array
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function isPng(buf: Uint8Array): boolean {
  return buf.length > 33 && Buffer.from(buf.buffer, buf.byteOffset, 8).equals(PNG_SIGNATURE)
}

/** Width/height from a PNG header without decoding. */
export function pngSize(buf: Uint8Array): { width: number; height: number } {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Decode a non-interlaced 8-bit PNG (gray, gray+alpha, RGB, RGBA or palette) to RGB. */
export function decodePng(input: Uint8Array): RgbImage {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (!isPng(buf)) throw new Error('not a PNG image')
  let off = 8
  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  let interlace = 0
  let palette: Buffer | undefined
  const idat: Buffer[] = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    off += 12 + len
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8] ?? 0
      colorType = data[9] ?? 0
      interlace = data[12] ?? 0
    } else if (type === 'PLTE') palette = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`)
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported')
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType]
  if (channels === undefined) throw new Error(`unsupported PNG colour type ${colorType}`)
  if (colorType === 3 && !palette) throw new Error('palette PNG without PLTE')
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  if (raw.length < (stride + 1) * height) throw new Error('truncated PNG data')
  const px = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const prev = dst - stride
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i] ?? 0
      const a = i >= channels ? (px[dst + i - channels] ?? 0) : 0
      const b = y > 0 ? (px[prev + i] ?? 0) : 0
      const c = y > 0 && i >= channels ? (px[prev + i - channels] ?? 0) : 0
      let v: number
      switch (filter) {
        case 0:
          v = x
          break
        case 1:
          v = x + a
          break
        case 2:
          v = x + b
          break
        case 3:
          v = x + ((a + b) >> 1)
          break
        case 4:
          v = x + paeth(a, b, c)
          break
        default:
          throw new Error(`bad PNG filter ${filter}`)
      }
      px[dst + i] = v & 0xff
    }
  }
  if (channels === 3) return { width, height, data: px }
  const out = new Uint8Array(width * height * 3)
  for (let i = 0, j = 0; i < width * height; i++, j += 3) {
    const s = i * channels
    if (colorType === 3) {
      const p = (px[s] ?? 0) * 3
      out[j] = palette?.[p] ?? 0
      out[j + 1] = palette?.[p + 1] ?? 0
      out[j + 2] = palette?.[p + 2] ?? 0
    } else if (channels <= 2) {
      out[j] = out[j + 1] = out[j + 2] = px[s] ?? 0
    } else {
      out[j] = px[s] ?? 0
      out[j + 1] = px[s + 1] ?? 0
      out[j + 2] = px[s + 2] ?? 0
    }
  }
  return { width, height, data: out }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff
  for (const p of parts) for (const b of p) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32([head.subarray(4), data]), 0)
  return Buffer.concat([head, data, crc])
}

/** Encode RGB pixels as PNG (per-row Sub/Up filter choice, zlib level 6). */
export function encodePng(img: RgbImage): Buffer {
  const { width, height, data } = img
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    const o = y * (stride + 1)
    // Pick the filter with the smallest sum of absolute residuals (cheap heuristic).
    let sumSub = 0
    let sumUp = 0
    for (let i = 0; i < stride; i++) {
      const v = data[row + i] ?? 0
      const s = (v - (i >= 3 ? (data[row + i - 3] ?? 0) : 0)) & 0xff
      const u = (v - (y > 0 ? (data[row - stride + i] ?? 0) : 0)) & 0xff
      sumSub += s < 128 ? s : 256 - s
      sumUp += u < 128 ? u : 256 - u
    }
    const up = y > 0 && sumUp < sumSub
    raw[o] = up ? 2 : 1
    for (let i = 0; i < stride; i++) {
      const v = data[row + i] ?? 0
      const ref = up ? (data[row - stride + i] ?? 0) : i >= 3 ? (data[row + i - 3] ?? 0) : 0
      raw[o + 1 + i] = (v - ref) & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ])
}

/** Convert Android `screencap` raw output (RGBA_8888/RGBX_8888 after a 12- or 16-byte header) to RGB. */
export function decodeScreencapRaw(buf: Uint8Array): RgbImage {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (b.length < 16) throw new Error('screencap output is too short')
  const width = b.readUInt32LE(0)
  const height = b.readUInt32LE(4)
  const format = b.readUInt32LE(8)
  const pixels = width * height * 4
  const header = b.length - pixels
  if (width === 0 || height === 0 || (header !== 12 && header !== 16)) {
    throw new Error(`unexpected screencap layout (${width}x${height}, ${b.length} bytes)`)
  }
  // PIXEL_FORMAT_RGBA_8888 = 1, RGBX_8888 = 2; BGRA_8888 = 5.
  if (format !== 1 && format !== 2 && format !== 5) throw new Error(`unsupported screencap pixel format ${format}`)
  const bgr = format === 5
  const out = new Uint8Array(width * height * 3)
  for (let i = 0, s = header, d = 0; i < width * height; i++, s += 4, d += 3) {
    out[d] = b[bgr ? s + 2 : s] ?? 0
    out[d + 1] = b[s + 1] ?? 0
    out[d + 2] = b[bgr ? s : s + 2] ?? 0
  }
  return { width, height, data: out }
}

/** Copy a rectangle (clamped to the image). */
export function crop(img: RgbImage, r: PixelRect): RgbImage {
  const x0 = Math.max(0, Math.min(img.width - 1, Math.floor(r.x)))
  const y0 = Math.max(0, Math.min(img.height - 1, Math.floor(r.y)))
  const x1 = Math.max(x0 + 1, Math.min(img.width, Math.ceil(r.x + r.width)))
  const y1 = Math.max(y0 + 1, Math.min(img.height, Math.ceil(r.y + r.height)))
  const w = x1 - x0
  const h = y1 - y0
  const out = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    const s = ((y0 + y) * img.width + x0) * 3
    out.set(img.data.subarray(s, s + w * 3), y * w * 3)
  }
  return { width: w, height: h, data: out }
}

/** Per output pixel: first source index and normalized area weights. */
function axisWeights(src: number, dst: number): { first: number; w: Float32Array }[] {
  const scale = src / dst
  const out: { first: number; w: Float32Array }[] = []
  for (let i = 0; i < dst; i++) {
    const a = i * scale
    const b = Math.min(src, (i + 1) * scale)
    const first = Math.min(src - 1, Math.floor(a))
    const last = Math.max(first + 1, Math.min(src, Math.ceil(b)))
    const w = new Float32Array(last - first)
    let sum = 0
    for (let j = first; j < last; j++) {
      const c = Math.max(0, Math.min(j + 1, b) - Math.max(j, a))
      w[j - first] = c
      sum += c
    }
    if (sum <= 0) {
      w.fill(0)
      w[0] = 1
      sum = 1
    }
    for (let k = 0; k < w.length; k++) w[k] = (w[k] ?? 0) / sum
    out.push({ first, w })
  }
  return out
}

/** Area-average resample (box filter; acts like nearest-neighbour with blended edges when enlarging). */
export function resize(img: RgbImage, width: number, height: number): RgbImage {
  width = Math.max(1, Math.round(width))
  height = Math.max(1, Math.round(height))
  if (width === img.width && height === img.height) return img
  const xs = axisWeights(img.width, width)
  const ys = axisWeights(img.height, height)
  const tmp = new Float32Array(width * img.height * 3)
  for (let y = 0; y < img.height; y++) {
    const row = y * img.width * 3
    const orow = y * width * 3
    for (let x = 0; x < width; x++) {
      const { first, w } = xs[x] ?? { first: 0, w: new Float32Array([1]) }
      let r = 0
      let g = 0
      let b = 0
      for (let k = 0; k < w.length; k++) {
        const p = row + (first + k) * 3
        const wk = w[k] ?? 0
        r += (img.data[p] ?? 0) * wk
        g += (img.data[p + 1] ?? 0) * wk
        b += (img.data[p + 2] ?? 0) * wk
      }
      tmp[orow + x * 3] = r
      tmp[orow + x * 3 + 1] = g
      tmp[orow + x * 3 + 2] = b
    }
  }
  const out = new Uint8Array(width * height * 3)
  const stride = width * 3
  for (let y = 0; y < height; y++) {
    const { first, w } = ys[y] ?? { first: 0, w: new Float32Array([1]) }
    const o = y * stride
    for (let i = 0; i < stride; i++) {
      let acc = 0
      for (let k = 0; k < w.length; k++) acc += (tmp[(first + k) * stride + i] ?? 0) * (w[k] ?? 0)
      out[o + i] = Math.min(255, Math.max(0, Math.round(acc)))
    }
  }
  return { width, height, data: out }
}

/** Output size for `w`×`h` with its long edge limited to `maxEdge`, optionally enlarging up to `maxUpscale`. */
export function fitSize(w: number, h: number, maxEdge: number, maxUpscale = 1): { width: number; height: number } {
  const s = Math.min(maxUpscale, maxEdge / Math.max(w, h))
  if (s === 1) return { width: w, height: h }
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) }
}

export type ImageFormat = 'png' | 'jpeg' | 'auto'

export interface EncodedImage {
  data: Buffer
  mediaType: 'image/png' | 'image/jpeg'
}

/**
 * Encode for the model. `auto` keeps PNG for flat UI content and switches to JPEG when the PNG
 * is large (photos, video, gradients), where JPEG is several times smaller at no visible cost.
 */
export function encodeImage(img: RgbImage, format: ImageFormat = 'auto', quality = 80): EncodedImage {
  if (format === 'jpeg') return { data: encodeJpeg(img, quality), mediaType: 'image/jpeg' }
  const png = encodePng(img)
  if (format === 'png') return { data: png, mediaType: 'image/png' }
  const budget = img.width * img.height * 0.6
  if (png.length <= budget) return { data: png, mediaType: 'image/png' }
  const jpeg = encodeJpeg(img, quality)
  return jpeg.length < png.length * 0.7
    ? { data: jpeg, mediaType: 'image/jpeg' }
    : { data: png, mediaType: 'image/png' }
}
