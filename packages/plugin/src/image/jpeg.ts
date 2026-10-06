// Minimal baseline JPEG encoder (JFIF, YCbCr 4:4:4, standard Huffman tables).
import type { RgbImage } from './codec.ts'

/** Natural (row-major) index of the i-th coefficient in zigzag order. */
export const ZIGZAG: readonly number[] = (() => {
  const out: number[] = []
  for (let s = 0; s < 15; s++) {
    const cells: number[] = []
    for (let y = 0; y < 8; y++) {
      const x = s - y
      if (x >= 0 && x < 8) cells.push(y * 8 + x)
    }
    // Even diagonals run bottom-left → top-right, odd ones top-right → bottom-left.
    if (s % 2 === 0) cells.reverse()
    out.push(...cells)
  }
  return out
})()

const LUM_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51,
  87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]
const CHR_Q = [
  17,
  18,
  24,
  47,
  99,
  99,
  99,
  99,
  18,
  21,
  26,
  66,
  99,
  99,
  99,
  99,
  24,
  26,
  56,
  99,
  99,
  99,
  99,
  99,
  47,
  66,
  99,
  99,
  99,
  99,
  99,
  99,
  ...Array<number>(32).fill(99),
]

interface HuffSpec {
  bits: number[]
  vals: number[]
}

export const DC_LUM: HuffSpec = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: [...Array(12).keys()] }
export const DC_CHR: HuffSpec = { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: [...Array(12).keys()] }
export const AC_LUM: HuffSpec = {
  bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  vals: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14,
    0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09,
    0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a,
    0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65,
    0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88,
    0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9,
    0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca,
    0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
    0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
}
export const AC_CHR: HuffSpec = {
  bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  vals: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32,
    0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16,
    0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39,
    0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64,
    0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86,
    0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8,
    0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
    0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
}

/** Canonical Huffman codes: symbol → [code, length]. */
function buildCodes({ bits, vals }: HuffSpec): Map<number, [number, number]> {
  const codes = new Map<number, [number, number]>()
  let code = 0
  let k = 0
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < (bits[len - 1] ?? 0); i++) codes.set(vals[k++] ?? 0, [code++, len])
    code <<= 1
  }
  return codes
}

function scaledQuant(base: number[], quality: number): number[] {
  const q = Math.min(100, Math.max(1, Math.round(quality)))
  const scale = q < 50 ? 5000 / q : 200 - q * 2
  return base.map(v => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))))
}

// DCT basis: COS[u * 8 + x] = c(u)/2 · cos((2x+1)uπ/16).
const COS = (() => {
  const t = new Float64Array(64)
  for (let u = 0; u < 8; u++)
    for (let x = 0; x < 8; x++)
      t[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16)
  return t
})()

class BitWriter {
  private bytes: number[] = []
  private acc = 0
  private n = 0

  write(code: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1)
      if (++this.n === 8) {
        this.bytes.push(this.acc)
        if (this.acc === 0xff) this.bytes.push(0)
        this.acc = 0
        this.n = 0
      }
    }
  }

  finish(): number[] {
    if (this.n > 0) this.write((1 << (8 - this.n)) - 1, 8 - this.n)
    return this.bytes
  }
}

function category(v: number): number {
  let a = Math.abs(v)
  let n = 0
  while (a) {
    n++
    a >>= 1
  }
  return n
}

/** Encode RGB pixels as a baseline JPEG; `quality` 1–100 (IJG scale). */
export function encodeJpeg(img: RgbImage, quality = 80): Buffer {
  const { width, height, data } = img
  const qy = scaledQuant(LUM_Q, quality)
  const qc = scaledQuant(CHR_Q, quality)
  const codes = {
    dcY: buildCodes(DC_LUM),
    acY: buildCodes(AC_LUM),
    dcC: buildCodes(DC_CHR),
    acC: buildCodes(AC_CHR),
  }
  const out: number[] = []
  const u16 = (v: number) => out.push((v >> 8) & 0xff, v & 0xff)
  const marker = (m: number, payload: number[]) => {
    out.push(0xff, m)
    u16(payload.length + 2)
    out.push(...payload)
  }
  out.push(0xff, 0xd8)
  marker(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])
  marker(0xdb, [0, ...ZIGZAG.map(i => qy[i] ?? 1), 1, ...ZIGZAG.map(i => qc[i] ?? 1)])
  marker(0xc0, [
    8,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    3,
    1,
    0x11,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ])
  const dht = (cls: number, id: number, spec: HuffSpec) => [(cls << 4) | id, ...spec.bits, ...spec.vals]
  marker(0xc4, [...dht(0, 0, DC_LUM), ...dht(1, 0, AC_LUM), ...dht(0, 1, DC_CHR), ...dht(1, 1, AC_CHR)])
  marker(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0])

  const bw = new BitWriter()
  const block = new Float64Array(64)
  const tmp = new Float64Array(64)
  const comp = [new Float64Array(64), new Float64Array(64), new Float64Array(64)]
  const prevDc = [0, 0, 0]

  const encodeBlock = (
    src: Float64Array,
    q: number[],
    dc: Map<number, [number, number]>,
    ac: Map<number, [number, number]>,
    ci: number,
  ) => {
    // Separable 2-D DCT-II: rows, then columns.
    for (let y = 0; y < 8; y++)
      for (let u = 0; u < 8; u++) {
        let s = 0
        for (let x = 0; x < 8; x++) s += (src[y * 8 + x] ?? 0) * (COS[u * 8 + x] ?? 0)
        tmp[y * 8 + u] = s
      }
    for (let u = 0; u < 8; u++)
      for (let v = 0; v < 8; v++) {
        let s = 0
        for (let y = 0; y < 8; y++) s += (tmp[y * 8 + u] ?? 0) * (COS[v * 8 + y] ?? 0)
        block[v * 8 + u] = s
      }
    const coef = ZIGZAG.map(i => Math.round((block[i] ?? 0) / (q[i] ?? 1)))
    const diff = (coef[0] ?? 0) - (prevDc[ci] ?? 0)
    prevDc[ci] = coef[0] ?? 0
    const emit = (table: Map<number, [number, number]>, sym: number) => {
      const c = table.get(sym)
      if (!c) throw new Error(`no Huffman code for symbol ${sym}`)
      bw.write(c[0], c[1])
    }
    const bitsOf = (v: number, n: number) => (v < 0 ? v + (1 << n) - 1 : v)
    const dn = category(diff)
    emit(dc, dn)
    if (dn) bw.write(bitsOf(diff, dn), dn)
    let run = 0
    let last = 63
    while (last > 0 && coef[last] === 0) last--
    for (let k = 1; k <= last; k++) {
      const v = coef[k] ?? 0
      if (v === 0) {
        run++
        continue
      }
      while (run > 15) {
        emit(ac, 0xf0)
        run -= 16
      }
      const n = category(v)
      emit(ac, (run << 4) | n)
      bw.write(bitsOf(v, n), n)
      run = 0
    }
    if (last < 63) emit(ac, 0x00)
  }

  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let y = 0; y < 8; y++) {
        const sy = Math.min(height - 1, by + y)
        for (let x = 0; x < 8; x++) {
          const sx = Math.min(width - 1, bx + x)
          const p = (sy * width + sx) * 3
          const r = data[p] ?? 0
          const g = data[p + 1] ?? 0
          const b = data[p + 2] ?? 0
          const i = y * 8 + x
          ;(comp[0] as Float64Array)[i] = 0.299 * r + 0.587 * g + 0.114 * b - 128
          ;(comp[1] as Float64Array)[i] = -0.168736 * r - 0.331264 * g + 0.5 * b
          ;(comp[2] as Float64Array)[i] = 0.5 * r - 0.418688 * g - 0.081312 * b
        }
      }
      encodeBlock(comp[0] as Float64Array, qy, codes.dcY, codes.acY, 0)
      encodeBlock(comp[1] as Float64Array, qc, codes.dcC, codes.acC, 1)
      encodeBlock(comp[2] as Float64Array, qc, codes.dcC, codes.acC, 2)
    }
  }
  const entropy = bw.finish()
  const head = Buffer.from(out)
  return Buffer.concat([head, Buffer.from(entropy), Buffer.from([0xff, 0xd9])])
}
