// Shared helpers for the model-facing environment tools.
import path from 'node:path'
import { EnvError } from '@dsh-environments/protocol'
import type { Environment } from '../env/environment.ts'
import type { SignalOptions } from '../env/types.ts'

export interface TextBlock {
  type: 'text'
  text: string
}

/** Output declaration of tools that return plain text. */
export const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string): TextBlock[] => [{ type: 'text', text: value }],
} as const

const MAX_TEXT = 30000

/** Keep the head and tail of long output. */
export function clip(text: string, max = MAX_TEXT): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.3)
  const tail = max - head
  return `${text.slice(0, head)}\n… [${text.length - max} characters omitted] …\n${text.slice(-tail)}`
}

/** Render text with 1-based line numbers like the built-in read tool. */
export function numbered(text: string, offset = 1, limit = 2000): string {
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const start = Math.max(1, offset)
  const slice = lines.slice(start - 1, start - 1 + limit)
  const body = slice.map((l, i) => `${start + i}: ${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`).join('\n')
  const more =
    start - 1 + slice.length < lines.length
      ? `\n\n(Showing lines ${start}-${start + slice.length - 1} of ${lines.length}. Use offset=${start + slice.length} to continue.)`
      : `\n\n(End of file - total ${lines.length} lines)`
  return body + more
}

export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export function formatSize(n: number | undefined | null): string {
  if (n === undefined || n === null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

export interface CopyResult {
  files: number
  bytes: number
  type: string
}

/** Recursively copy a file or directory between two environments, streaming through the host. */
export async function copyBetween(
  src: Environment,
  srcPath: string,
  dst: Environment,
  dstPath: string,
  {
    overwrite = false,
    signal,
    onFile,
  }: SignalOptions & { overwrite?: boolean; onFile?: (src: string, dst: string, bytes: number) => void } = {},
): Promise<CopyResult> {
  const st = await src.stat(srcPath)
  if (!st) throw new EnvError('ENOENT', `source not found: ${srcPath}`)
  let files = 0
  let bytes = 0
  const copyFile = async (s: string, d: string) => {
    signal?.throwIfAborted()
    if (!overwrite && (await dst.stat(d)))
      throw new EnvError('EEXIST', `destination exists: ${d} (pass overwrite=true)`)
    const data = await src.readFile(s, { maxBytes: 2 * 1024 * 1024 * 1024, signal })
    await dst.writeFile(d, data, { mode: 'overwrite', atomic: true, mkdirs: true, signal })
    files++
    bytes += data.length
    onFile?.(s, d, data.length)
  }
  const walk = async (s: string, d: string): Promise<void> => {
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

export function sniffImage(buf: Buffer): string | undefined {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp'
  if (buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  return undefined
}

export function baseName(p: unknown): string {
  return path.posix.basename(String(p).replace(/\\/g, '/'))
}

/** Remove ANSI escape sequences and turn bare carriage returns into newlines. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\r(?!\n)/g, '\n')
}
