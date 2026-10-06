// A process running over an SSH exec channel.
import type { Readable, Writable } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import type { ExitInfo } from '@dsh-environments/protocol'
import type { EnvProcess } from '../types.ts'

export class SshProcess implements EnvProcess {
  readonly stream: ClientChannel
  readonly pty: boolean
  readonly pid = undefined
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exited: Promise<ExitInfo>

  constructor(stream: ClientChannel, pty: boolean) {
    this.stream = stream
    this.pty = pty
    this.stdin = stream
    this.stdout = stream
    this.stderr = stream.stderr
    this.exited = new Promise(resolve => {
      let exit: ExitInfo | undefined
      stream.on('exit', (code: number | null, signal?: string | null) => {
        exit = { code: code ?? null, signal: signal ?? null }
      })
      stream.on('close', () => resolve(exit ?? { code: null, signal: 'CLOSED' }))
    })
  }

  write(data: Uint8Array | string): Promise<void> {
    return new Promise((resolve, reject) => this.stream.write(data, e => (e ? reject(e) : resolve())))
  }

  end(): void {
    this.stream.end()
  }

  resize(rows: number, cols: number): Promise<void> {
    this.stream.setWindow(rows, cols, 0, 0)
    return Promise.resolve()
  }

  kill(signal = 'KILL'): Promise<void> {
    try {
      this.stream.signal(signal)
    } catch {
      // unsupported by the server
    }
    try {
      this.stream.close()
    } catch {
      // already closed
    }
    return Promise.resolve()
  }
}
