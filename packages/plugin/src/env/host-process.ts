// Running commands on the harness host (adb, elevation helpers, ...).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { EnvError, type ExitInfo } from '@dsh-environments/protocol'
import type { EnvProcess } from './types.ts'

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
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() })
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
