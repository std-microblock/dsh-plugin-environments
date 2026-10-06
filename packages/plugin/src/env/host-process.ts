// Running commands on the harness host (adb, elevation helpers, ...).
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isUtf8 } from 'node:buffer'
import type { Readable, Writable } from 'node:stream'
import { EnvError, type ExitInfo } from '@dsh-environments/protocol'
import type { EnvProcess } from './types.ts'

/** WHATWG encoding label for a Windows code page (approximate for OEM-only pages). */
export function codePageLabel(cp: number): string {
  const known: Record<number, string> = {
    936: 'gbk',
    54936: 'gb18030',
    950: 'big5',
    932: 'shift_jis',
    949: 'euc-kr',
    866: 'ibm866',
    874: 'windows-874',
    20866: 'koi8-r',
    65001: 'utf-8',
  }
  const label = known[cp]
  if (label) return label
  if (cp >= 1250 && cp <= 1258) return `windows-${cp}`
  return 'windows-1252'
}

let legacy: TextDecoder | undefined

/** Decoder for the host's OEM code page (what console programs write into pipes). */
function legacyDecoder(): TextDecoder {
  if (legacy) return legacy
  let cp = 437
  try {
    // A fresh windowless console starts with the OEM code page; chcp prints it.
    const out = execFileSync('cmd.exe', ['/d', '/c', 'chcp'], { windowsHide: true, timeout: 5000 }).toString('latin1')
    cp = Number(/(\d+)\s*$/.exec(out.trim())?.[1] ?? cp)
  } catch {
    // keep the default
  }
  try {
    legacy = new TextDecoder(codePageLabel(cp))
  } catch {
    legacy = new TextDecoder('windows-1252')
  }
  return legacy
}

/**
 * Text from a host program's output: valid UTF-8 lines are kept, other lines (console programs
 * on a non-UTF-8 code page, e.g. GBK on Chinese Windows) are decoded with the OEM code page.
 */
export function decodeHostText(buf: Uint8Array, decoder?: () => TextDecoder): string {
  if (isUtf8(buf)) return Buffer.from(buf).toString('utf8')
  if (!decoder && process.platform !== 'win32') return Buffer.from(buf).toString('utf8')
  const dec = (decoder ?? legacyDecoder)()
  let out = ''
  let start = 0
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start)
    const end = nl < 0 ? buf.length : nl + 1
    const line = buf.subarray(start, end)
    out += isUtf8(line) ? Buffer.from(line).toString('utf8') : dec.decode(line)
    start = end
  }
  return out
}

export interface RunHostOptions {
  input?: Uint8Array | string | undefined
  signal?: AbortSignal | undefined
  timeoutMs?: number
  maxBytes?: number
}

export interface RunHostResult {
  code: number | null
  stdout: Buffer
  stderr: string
}

/** Run a host command and collect its output. */
export function runHost(
  cmd: string,
  args: readonly string[],
  { input, signal, timeoutMs = 120000, maxBytes = 64 * 1024 * 1024 }: RunHostOptions = {},
): Promise<RunHostResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    child.stdout.on('data', (d: Buffer) => {
      size += d.length
      if (size <= maxBytes) out.push(d)
    })
    child.stderr.on('data', (d: Buffer) => err.push(d))
    const kill = () => {
      try {
        child.kill()
      } catch {
        // already exited
      }
    }
    const timer = setTimeout(kill, timeoutMs)
    signal?.addEventListener('abort', kill, { once: true })
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(new EnvError(e.code === 'ENOENT' ? 'ENOENT' : 'EIO', `${cmd}: ${e.message}`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', kill)
      if (size > maxBytes) {
        reject(new EnvError('ETOOBIG', `output exceeds ${maxBytes} bytes`))
        return
      }
      resolve({ code, stdout: Buffer.concat(out), stderr: decodeHostText(Buffer.concat(err)) })
    })
    child.stdin.on('error', () => {})
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/** Wrap a host child process in the environment process interface. */
export class HostChildProcess implements EnvProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly pid: number | undefined
  readonly pty: boolean
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exited: Promise<ExitInfo>
  private readonly onResize: ((rows: number, cols: number) => Promise<void> | void) | undefined

  constructor(
    child: ChildProcessWithoutNullStreams,
    { pty = false, onResize }: { pty?: boolean; onResize?: (rows: number, cols: number) => Promise<void> | void } = {},
  ) {
    this.child = child
    this.pid = child.pid
    this.pty = pty
    this.stdin = child.stdin
    this.stdout = child.stdout
    this.stderr = child.stderr
    this.onResize = onResize
    child.stdin.on('error', () => {})
    this.exited = new Promise(resolve => {
      child.once('error', () => resolve({ code: null, signal: 'ERROR' }))
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
  }

  write(data: Uint8Array | string): Promise<void> {
    return new Promise((resolve, reject) => this.child.stdin.write(data, e => (e ? reject(e) : resolve())))
  }

  end(): void {
    this.child.stdin.end()
  }

  async resize(rows: number, cols: number): Promise<void> {
    await this.onResize?.(rows, cols)
  }

  async kill(): Promise<void> {
    if (this.child.exitCode !== null) return
    if (process.platform === 'win32') {
      await runHost('taskkill', ['/T', '/F', '/PID', String(this.child.pid)]).catch(() => {})
    } else {
      try {
        this.child.kill('SIGKILL')
      } catch {
        // already exited
      }
    }
  }
}
