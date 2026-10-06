// A process running behind a dsh-env-server channel.
import { Readable, type Writable } from 'node:stream'
import type { Channel, EnvClient, ExitInfo, KillSignal } from '@dsh-environments/protocol'
import type { EnvProcess } from '../types.ts'

export class ServerProcess implements EnvProcess {
  readonly client: EnvClient
  readonly channel: Channel
  readonly pid: number
  readonly pty: boolean
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exited: Promise<ExitInfo>

  constructor(client: EnvClient, channel: Channel, pid: number, pty: boolean) {
    this.client = client
    this.channel = channel
    this.pid = pid
    this.pty = pty
    this.stdin = channel.writable(0)
    this.stdout = channel.readable(1)
    // A PTY merges stderr into stdout.
    this.stderr = pty ? Readable.from([]) : channel.readable(2)
    // A lost connection destroys the streams with an error; `exited` reports it, so an
    // unobserved stream must not raise an uncaught 'error' event.
    for (const s of [this.stdin, this.stdout, this.stderr]) s.on('error', () => {})
    this.exited = new Promise(resolve => {
      channel.once('exit', exit => resolve(exit))
      void channel.done.then(({ error }) => {
        if (channel.exit) resolve(channel.exit)
        else resolve({ code: null, signal: error ? 'DISCONNECTED' : 'KILLED' })
      })
    })
  }

  write(data: Uint8Array | string): Promise<void> {
    return this.channel.write(data, 0)
  }

  end(): void {
    this.channel.end(0)
  }

  async resize(rows: number, cols: number): Promise<void> {
    await this.client.call('proc.resize', { ch: this.channel.ch, rows, cols })
  }

  async kill(signal: KillSignal = 'KILL'): Promise<void> {
    if (this.channel.closed) return
    try {
      await this.client.call('proc.kill', { ch: this.channel.ch, signal })
    } catch {
      this.channel.close()
    }
  }
}
