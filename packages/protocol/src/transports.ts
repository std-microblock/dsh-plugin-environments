// Transport adapters.
import type { ChildProcessByStdio } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import type { Transport } from './client.ts'

interface TransportEvents {
  data: [Buffer]
  close: []
  error: [Error]
}

/**
 * A {@link Transport} built from callbacks: the source pushes events with `emit`,
 * the connection writes through the supplied functions.
 */
export class CallbackTransport extends EventEmitter<TransportEvents> implements Transport {
  private readonly writeFn: (data: Buffer) => unknown
  private readonly endFn: () => unknown
  private readonly destroyFn: () => unknown

  constructor(fns: { write: (data: Buffer) => unknown; end: () => unknown; destroy: () => unknown }) {
    super()
    this.writeFn = fns.write
    this.endFn = fns.end
    this.destroyFn = fns.destroy
  }

  write(data: Buffer): unknown {
    return this.writeFn(data)
  }

  end(): unknown {
    return this.endFn()
  }

  destroy(): unknown {
    return this.destroyFn()
  }
}

/** A child process with piped stdin/stdout (stderr may be anything). */
export type StdioChild = ChildProcessByStdio<Writable, Readable, Readable | null>

/** Adapt a child process (stdio mode server) to the transport interface. */
export function childTransport(child: StdioChild): Transport {
  const t = new CallbackTransport({
    write: buf => child.stdin.write(buf),
    end: () => child.stdin.end(),
    destroy: () => {
      try {
        child.stdin.end()
      } catch {
        // stdin already closed
      }
      setTimeout(() => {
        try {
          child.kill()
        } catch {
          // already exited
        }
      }, 2000).unref()
    },
  })
  child.stdout.on('data', (d: Buffer) => t.emit('data', d))
  child.on('exit', () => t.emit('close'))
  child.on('error', e => t.emit('error', e))
  child.stdin.on('error', () => {})
  return t
}
