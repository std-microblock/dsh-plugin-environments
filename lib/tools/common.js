// Shared helpers for the model-facing environment tools.
import path from 'node:path'

export const TEXT_OUTPUT = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }

const MAX_TEXT = 30000

/** Keep the head and tail of long output. */
export function clip(text, max = MAX_TEXT) {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.3)
  const tail = max - head
  return `${text.slice(0, head)}\n… [${text.length - max} characters omitted] …\n${text.slice(-tail)}`
}

/** Render text with 1-based line numbers like the built-in read tool. */
export function numbered(text, offset = 1, limit = 2000) {
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const start = Math.max(1, offset)
  const slice = lines.slice(start - 1, start - 1 + limit)
  const body = slice.map((l, i) => `${start + i}: ${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`).join('\n')
  const more = start - 1 + slice.length < lines.length ? `\n\n(Showing lines ${start}-${start + slice.length - 1} of ${lines.length}. Use offset=${start + slice.length} to continue.)` : `\n\n(End of file - total ${lines.length} lines)`
  return body + more
}

export function looksBinary(buf) {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export function formatSize(n) {
  if (n === undefined || n === null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

/** Recursively copy a file or directory between two environments, streaming through the host. */
export async function copyBetween(src, srcPath, dst, dstPath, { overwrite = false, signal, onFile } = {}) {
  const st = await src.stat(srcPath)
  if (!st) throw Object.assign(new Error(`source not found: ${srcPath}`), { code: 'ENOENT' })
  let files = 0
  let bytes = 0
  const copyFile = async (s, d) => {
    signal?.throwIfAborted?.()
    if (!overwrite && await dst.stat(d)) throw Object.assign(new Error(`destination exists: ${d} (pass overwrite=true)`), { code: 'EEXIST' })
    const data = await src.readFile(s, { maxBytes: 2 * 1024 * 1024 * 1024, signal })
    await dst.writeFile(d, data, { mode: 'overwrite', atomic: true, mkdirs: true, signal })
    files++
    bytes += data.length
    onFile?.(s, d, data.length)
  }
  const walk = async (s, d) => {
    const info = await src.stat(s)
    if (info?.type === 'dir') {
      await dst.mkdir(d, { recursive: true })
      for (const e of await src.readdir(s)) await walk(src.path.join(s, e.name), dst.path.join(d, e.name))
    } else if (info?.type === 'file') {
      await copyFile(s, d)
    }
  }
  await walk(srcPath, dstPath)
  return { files, bytes, type: st.type }
}

/** Check whether the calling route accepts images (mirrors read_image). */
export async function imageCapable(ctx, exec) {
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) return true
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return !info.inputModalities || info.inputModalities.includes('image')
  } catch {
    return true
  }
}

export const IMAGE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
    image: {
      type: 'object',
      additionalProperties: true,
      properties: {
        attachmentId: { type: 'string', required: true },
        mediaType: { type: 'string', required: true },
        bytes: { type: 'integer', required: true },
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
  },
}

export function renderImageResult(_args, value) {
  const blocks = [{ type: 'text', text: value.text }]
  if (value.image) blocks.push({ type: 'image', attachment: value.image })
  return blocks
}

/** Persist PNG/JPEG bytes as an attachment and build the image tool value. */
export async function imageValue(ctx, exec, data, { name, text, mediaType = 'image/png' }) {
  const attachments = ctx.get('attachments')
  if (!attachments) return { text: `${text}\n(no attachment store is mounted, so the image cannot be shown)` }
  if (!(await imageCapable(ctx, exec))) return { text: `${text}\n(the current model does not accept images; switch to an image-capable model to view it)` }
  const ref = await attachments.saveImage({ data: new Uint8Array(data), mediaType, name })
  let note = `${text}\n${ref.mediaType} ${ref.width}x${ref.height}`
  if (ref.originalDimensions) {
    const fx = (ref.originalDimensions.width / ref.width).toFixed(3)
    const fy = (ref.originalDimensions.height / ref.height).toFixed(3)
    note += ` (downscaled from ${ref.originalDimensions.width}x${ref.originalDimensions.height}; multiply x by ${fx} and y by ${fy} to get screen coordinates)`
  }
  const image = {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...ref.name !== undefined ? { name: ref.name } : {},
    ...ref.originalDimensions ? { originalDimensions: { ...ref.originalDimensions } } : {},
  }
  return { text: note, image }
}

export function sniffImage(buf) {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  return undefined
}

export function baseName(p) {
  return path.posix.basename(String(p).replace(/\\/g, '/'))
}
