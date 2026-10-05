// Base class for every environment implementation.
import { EventEmitter } from 'node:events'
import path from 'node:path'

let tunnelSeq = 0

/**
 * An environment is a device the harness can control: files, processes, tunnels and
 * (optionally) screen/input. Implementations: ServerEnvironment (dsh-env-server over
 * TCP / stdio / ssh), AdbEnvironment, SshEnvironment.
 */
export class Environment extends EventEmitter {
  constructor({ id, name, kind, source } = {}) {
    super()
    this.id = id
    this.name = name ?? id
    this.kind = kind
    this.source = source
    this.info = undefined
    this.closed = false
    this.closeError = undefined
    this.tunnels = new Map()
  }

  get caps() {
    return new Set(this.info?.caps ?? [])
  }

  get family() {
    return this.info?.family ?? 'posix'
  }

  /** Path module matching the environment's platform. */
  get path() {
    return this.family === 'windows' ? path.win32 : path.posix
  }

  /** Resolve a possibly relative path against cwd in the environment's spelling. */
  resolvePath(p, cwd) {
    const P = this.path
    if (P.isAbsolute(p)) return P.normalize(p)
    return P.resolve(cwd ?? this.info?.cwd ?? (this.family === 'windows' ? 'C:\\' : '/'), p)
  }

  trackTunnel(t) {
    const id = `t${++tunnelSeq}`
    const entry = { id, ...t, createdAt: Date.now() }
    const close = t.close
    entry.close = async () => {
      if (!this.tunnels.has(id)) return
      this.tunnels.delete(id)
      await close()
      this.emit('change')
    }
    this.tunnels.set(id, entry)
    this.emit('change')
    return entry
  }

  listTunnels() {
    return [...this.tunnels.values()].map(({ close, ...rest }) => rest)
  }

  markClosed(error) {
    if (this.closed) return
    this.closed = true
    this.closeError = error
    for (const t of [...this.tunnels.values()]) t.close().catch(() => {})
    this.emit('close', error)
  }

  /** Close tunnels and the transport. Idempotent. */
  async close() {
    if (this.closed) return
    for (const t of [...this.tunnels.values()]) await t.close().catch(() => {})
    try {
      await this.closeTransport()
    } finally {
      this.markClosed()
    }
  }

  async closeTransport() {}

  // ---- capability defaults -------------------------------------------------

  async stat() { throw unsupported(this, 'stat') }
  async readdir() { throw unsupported(this, 'readdir') }
  async readFile() { throw unsupported(this, 'readFile') }
  async writeFile() { throw unsupported(this, 'writeFile') }
  async mkdir() { throw unsupported(this, 'mkdir') }
  async remove() { throw unsupported(this, 'remove') }
  async rename() { throw unsupported(this, 'rename') }
  async realpath(p) { return p }
  async glob() { throw unsupported(this, 'glob') }
  async grep() { throw unsupported(this, 'grep') }
  async spawn() { throw unsupported(this, 'spawn') }
  async forward() { throw unsupported(this, 'forward') }
  async reverse() { throw unsupported(this, 'reverse') }
  async screenshot() { throw unsupported(this, 'screenshot') }
  async input() { throw unsupported(this, 'input') }

  /** Run a command to completion and collect output (convenience). */
  async exec(spec, { signal, stdin, maxBytes = 4 * 1024 * 1024, timeoutMs } = {}) {
    const proc = await this.spawn(spec, { signal })
    const out = []
    const err = []
    let outLen = 0
    let errLen = 0
    let truncated = false
    proc.stdout.on('data', d => { if (outLen < maxBytes) { out.push(d); outLen += d.length } else truncated = true })
    proc.stderr.on('data', d => { if (errLen < maxBytes) { err.push(d); errLen += d.length } else truncated = true })
    const onAbort = () => proc.kill().catch(() => {})
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = timeoutMs ? setTimeout(onAbort, timeoutMs) : undefined
    try {
      if (stdin !== undefined) await proc.write(Buffer.isBuffer(stdin) ? stdin : Buffer.from(stdin))
      proc.end()
      const exit = await proc.exited
      const ended = s => s.readableEnded ? undefined : new Promise(r => { s.once('end', r); s.once('close', r); setTimeout(r, 2000) })
      await Promise.all([ended(proc.stdout), ended(proc.stderr)])
      return {
        code: exit.code,
        signal: exit.signal,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        truncated,
        timedOut: signal?.aborted ? false : undefined,
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  describe() {
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      info: this.info,
      closed: this.closed,
      tunnels: this.listTunnels(),
    }
  }
}

export function unsupported(env, op) {
  const e = new Error(`${env.name ?? 'environment'} (${env.kind}) does not support ${op}`)
  e.code = 'UNSUPPORTED'
  return e
}
