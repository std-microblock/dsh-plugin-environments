// Reverse connections: dsh-env-server instances dial the plugin (`dsh-env-server connect`).
//
// The hub runs opt-in TCP and/or WebSocket listeners. Every incoming connection runs the
// secure-channel handshake as responder; the initiator names its environment id and must
// prove knowledge of that environment's secret. Authenticated connections wait in a per-id
// pool of spares (kept alive with protocol pings) until `take()` hands one to a new
// ServerEnvironment; the server then dials the next spare.
import { EventEmitter } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import {
  CallbackTransport,
  encodeFrame,
  EnvError,
  errorMessage,
  secureRespond,
  wsAccept,
  type Transport,
} from '@dsh-environments/protocol'

/** Listener configuration (persisted plugin state; editable in the GUI). */
export interface ReverseListenerSettings {
  tcp?: { enabled?: boolean; host?: string; port?: number }
  ws?: { enabled?: boolean; host?: string; port?: number; path?: string }
  /** Host name or address the remote side should dial (shown in generated commands). */
  publicHost?: string
}

export const REVERSE_DEFAULTS = {
  tcp: { host: '0.0.0.0', port: 7462 },
  ws: { host: '0.0.0.0', port: 7463, path: '/dsh-env' },
} as const

export interface ListenerStatus {
  enabled: boolean
  listening: boolean
  host: string
  port: number
  path?: string
  error?: string | undefined
}

export interface ReverseStatus {
  tcp: ListenerStatus
  ws: ListenerStatus
  publicHost: string
}

export interface ReverseConnectionState {
  /** Spare connections waiting to be used. */
  idle: number
  /** Connections handed to environments and still open. */
  active: number
  /** Peer address of the most recent connection. */
  peer: string | undefined
  since: number | undefined
}

interface Spare {
  transport: CallbackTransport
  peer: string
  since: number
  ping: NodeJS.Timeout
  /** Switch the connection from idle (pings) to forwarding into `target`. */
  handOver: (target: CallbackTransport) => void
  dispose: () => void
}

interface Waiter {
  resolve: (t: Transport) => void
  reject: (e: Error) => void
}

export interface ReverseHubEvents {
  change: []
}

/** Look up the secret of a reverse environment by id (undefined = unknown id). */
export type SecretLookup = (id: string) => string | undefined

const PING_MS = 15000

export class ReverseHub extends EventEmitter<ReverseHubEvents> {
  private readonly lookup: SecretLookup
  private readonly log: ((msg: string) => void) | undefined
  private settings: ReverseListenerSettings = {}
  private tcpServer: net.Server | undefined
  private httpServer: http.Server | undefined
  private readonly status: ReverseStatus = {
    tcp: { enabled: false, listening: false, host: REVERSE_DEFAULTS.tcp.host, port: REVERSE_DEFAULTS.tcp.port },
    ws: {
      enabled: false,
      listening: false,
      host: REVERSE_DEFAULTS.ws.host,
      port: REVERSE_DEFAULTS.ws.port,
      path: REVERSE_DEFAULTS.ws.path,
    },
    publicHost: defaultPublicHost(),
  }
  private readonly spares = new Map<string, Spare[]>()
  private readonly active = new Map<string, Set<Transport>>()
  private readonly lastPeer = new Map<string, { peer: string; since: number }>()
  private readonly waiters = new Map<string, Waiter[]>()
  private readonly sockets = new Set<net.Socket>()
  private disposed = false

  constructor(lookup: SecretLookup, log?: (msg: string) => void) {
    super()
    this.lookup = lookup
    this.log = log
  }

  /** Apply listener settings, (re)starting listeners whose address changed. */
  async configure(settings: ReverseListenerSettings): Promise<ReverseStatus> {
    this.settings = settings
    this.status.publicHost = settings.publicHost?.trim() || defaultPublicHost()
    const tcp = { ...REVERSE_DEFAULTS.tcp, ...settings.tcp }
    const ws = { ...REVERSE_DEFAULTS.ws, ...settings.ws }
    const tcpChanged =
      !!tcp.enabled !== this.status.tcp.enabled ||
      tcp.host !== this.status.tcp.host ||
      tcp.port !== this.status.tcp.port
    const wsChanged =
      !!ws.enabled !== this.status.ws.enabled ||
      ws.host !== this.status.ws.host ||
      ws.port !== this.status.ws.port ||
      ws.path !== this.status.ws.path
    if (tcpChanged) {
      await closeServer(this.tcpServer)
      this.tcpServer = undefined
      this.status.tcp = { enabled: !!tcp.enabled, listening: false, host: tcp.host, port: tcp.port }
      if (tcp.enabled && !this.disposed) {
        const server = net.createServer(socket => this.onSocket(socket, socket))
        this.tcpServer = server
        await this.listen(server, this.status.tcp)
      }
    }
    if (wsChanged) {
      await closeServer(this.httpServer)
      this.httpServer = undefined
      const path = ws.path.startsWith('/') ? ws.path : `/${ws.path}`
      this.status.ws = { enabled: !!ws.enabled, listening: false, host: ws.host, port: ws.port, path }
      if (ws.enabled && !this.disposed) {
        const server = http.createServer((_req, res) => {
          res.writeHead(426, { 'content-type': 'text/plain' }).end('dsh-env reverse endpoint: WebSocket only\n')
        })
        server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
          const reqPath = (req.url ?? '').split('?')[0]
          if (reqPath !== path) {
            socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            return
          }
          const t = wsAccept(req, socket, head)
          if (t) this.onSocket(t, socket)
        })
        this.httpServer = server
        await this.listen(server, this.status.ws)
      }
    }
    this.emit('change')
    return this.describe()
  }

  private listen(server: net.Server, status: ListenerStatus): Promise<void> {
    return new Promise(resolve => {
      const onError = (e: Error) => {
        status.listening = false
        status.error = errorMessage(e)
        this.log?.(`reverse listener ${status.host}:${status.port}: ${status.error}`)
        resolve()
      }
      server.once('error', onError)
      server.listen(status.port, status.host, () => {
        server.off('error', onError)
        server.on('error', e => this.log?.(`reverse listener: ${errorMessage(e)}`))
        status.listening = true
        status.error = undefined
        status.port = (server.address() as net.AddressInfo).port
        resolve()
      })
    })
  }

  describe(): ReverseStatus {
    return { tcp: { ...this.status.tcp }, ws: { ...this.status.ws }, publicHost: this.status.publicHost }
  }

  get currentSettings(): ReverseListenerSettings {
    return this.settings
  }

  /** Connection state of one reverse environment. */
  state(id: string): ReverseConnectionState {
    const last = this.lastPeer.get(id)
    return {
      idle: this.spares.get(id)?.length ?? 0,
      active: this.active.get(id)?.size ?? 0,
      peer: last?.peer,
      since: last?.since,
    }
  }

  connected(id: string): boolean {
    const s = this.state(id)
    return s.idle > 0 || s.active > 0
  }

  private onSocket(raw: Transport, socket: net.Socket): void {
    if (this.disposed) {
      socket.destroy()
      return
    }
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 30000)
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    const peer = `${socket.remoteAddress ?? '?'}:${String(socket.remotePort ?? '')}`
    secureRespond(raw, id => this.lookup(id)).then(
      ({ transport, id }) => this.addSpare(id, transport, peer),
      (e: unknown) => {
        this.log?.(`reverse connection from ${peer} rejected: ${errorMessage(e)}`)
        socket.destroy()
      },
    )
  }

  private addSpare(id: string, inner: Transport, peer: string): void {
    // One relay per connection: idle it answers keepalive pongs, after hand-over it forwards.
    let target: CallbackTransport | undefined
    let closed = false
    const outer = new CallbackTransport({
      write: d => inner.write(d),
      end: () => inner.end?.(),
      destroy: () => inner.destroy?.(),
    })
    let n = 0
    const spare: Spare = {
      transport: outer,
      peer,
      since: Date.now(),
      ping: setInterval(() => inner.write(encodeFrame({ t: 'ping', n: ++n })), PING_MS),
      handOver: t => {
        clearInterval(spare.ping)
        target = t
      },
      dispose: () => {
        clearInterval(spare.ping)
        inner.destroy?.()
      },
    }
    spare.ping.unref()
    inner.on('data', d => {
      // While idle the only traffic is `pong` frames; they are dropped.
      if (target) target.push(d)
    })
    const onClose = () => {
      if (closed) return
      closed = true
      clearInterval(spare.ping)
      this.removeSpare(id, spare)
      if (target) target.emit('close')
      this.emit('change')
    }
    inner.on('close', onClose)
    inner.on('error', e => {
      if (target) target.emit('error', e)
      onClose()
    })
    this.lastPeer.set(id, { peer, since: Date.now() })
    const waiter = this.waiters.get(id)?.shift()
    if (waiter) {
      waiter.resolve(this.activate(id, spare))
    } else {
      const list = this.spares.get(id) ?? []
      list.push(spare)
      this.spares.set(id, list)
      // A well-behaved server keeps a single spare; cap what a misbehaving one can park here.
      while (list.length > 4) list.shift()?.dispose()
    }
    this.emit('change')
  }

  private removeSpare(id: string, spare: Spare): void {
    const list = this.spares.get(id)
    if (!list) return
    const i = list.indexOf(spare)
    if (i >= 0) list.splice(i, 1)
  }

  private activate(id: string, spare: Spare): Transport {
    this.removeSpare(id, spare)
    const t = new CallbackTransport({
      write: d => spare.transport.write(d),
      end: () => spare.transport.end(),
      destroy: () => spare.transport.destroy(),
    })
    spare.handOver(t)
    const set = this.active.get(id) ?? new Set<Transport>()
    this.active.set(id, set)
    set.add(t)
    t.on('close', () => {
      set.delete(t)
      this.emit('change')
    })
    return t
  }

  /**
   * Take a connection for environment `id`, waiting up to `timeoutMs` for the server to dial
   * in (it reconnects with backoff, and dials a new spare right after one is taken).
   */
  take(
    id: string,
    { signal, timeoutMs = 10000 }: { signal?: AbortSignal | undefined; timeoutMs?: number } = {},
  ): Promise<Transport> {
    const spare = this.spares.get(id)?.shift()
    if (spare) {
      const t = this.activate(id, spare)
      this.emit('change')
      return Promise.resolve(t)
    }
    if (!this.status.tcp.listening && !this.status.ws.listening) {
      return Promise.reject(
        new EnvError('ENOENT', 'reverse connections are disabled: enable a TCP or WebSocket listener first'),
      )
    }
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(id) ?? []
      this.waiters.set(id, list)
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const i = list.indexOf(waiter)
        if (i >= 0) list.splice(i, 1)
      }
      const waiter: Waiter = {
        resolve: t => {
          cleanup()
          resolve(t)
        },
        reject: e => {
          cleanup()
          reject(e)
        },
      }
      const onAbort = () => waiter.reject(new EnvError('CANCELLED', 'aborted'))
      const timer = setTimeout(
        () =>
          waiter.reject(
            new EnvError('ETIMEDOUT', `environment ${id} is not connected (run dsh-env-server connect on it)`),
          ),
        timeoutMs,
      )
      signal?.addEventListener('abort', onAbort, { once: true })
      list.push(waiter)
    })
  }

  /** Drop every connection of `id` (secret rotated or environment deleted). */
  disconnect(id: string): void {
    for (const s of this.spares.get(id) ?? []) s.dispose()
    this.spares.delete(id)
    for (const t of this.active.get(id) ?? []) t.destroy?.()
    this.emit('change')
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const list of this.waiters.values())
      for (const w of [...list]) w.reject(new EnvError('CLOSED', 'plugin is shutting down'))
    for (const id of [...this.spares.keys(), ...this.active.keys()]) this.disconnect(id)
    for (const s of this.sockets) s.destroy()
    await Promise.all([closeServer(this.tcpServer), closeServer(this.httpServer)])
    this.tcpServer = undefined
    this.httpServer = undefined
  }
}

/** Validate settings coming from the GUI / plugin config. */
export function sanitizeReverseSettings(input: unknown): ReverseListenerSettings {
  const o = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
  const port = (v: unknown, fallback: number): number => {
    const n = Number(v)
    if (v === undefined || v === '' || v === null) return fallback
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new EnvError('EINVAL', `invalid port ${JSON.stringify(v)}`)
    return n
  }
  const host = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() ? v.trim() : fallback)
  const root = o(input)
  const tcp = o(root['tcp'])
  const ws = o(root['ws'])
  const path = host(ws['path'], REVERSE_DEFAULTS.ws.path)
  const out: ReverseListenerSettings = {
    tcp: {
      enabled: tcp['enabled'] === true,
      host: host(tcp['host'], REVERSE_DEFAULTS.tcp.host),
      port: port(tcp['port'], REVERSE_DEFAULTS.tcp.port),
    },
    ws: {
      enabled: ws['enabled'] === true,
      host: host(ws['host'], REVERSE_DEFAULTS.ws.host),
      port: port(ws['port'], REVERSE_DEFAULTS.ws.port),
      path: path.startsWith('/') ? path : `/${path}`,
    },
  }
  const pub = root['publicHost']
  if (typeof pub === 'string' && pub.trim()) out.publicHost = pub.trim()
  return out
}

function closeServer(server: net.Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve()
  return new Promise(resolve => server.close(() => resolve()))
}

/** First non-internal IPv4 address, else the host name. */
export function defaultPublicHost(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return os.hostname()
}

export interface ReverseCommandOptions {
  id: string
  secret: string
  status: ReverseStatus
  cwd?: string | undefined
}

/** Ready-to-paste commands that connect a host to this plugin (secret written to a 0600 file). */
export function reverseCommands({ id, secret, status, cwd }: ReverseCommandOptions): {
  urls: string[]
  posix: string | undefined
  windows: string | undefined
} {
  const host = status.publicHost.includes(':') ? `[${status.publicHost}]` : status.publicHost
  const urls: string[] = []
  if (status.ws.enabled) urls.push(`ws://${host}:${status.ws.port}${status.ws.path ?? '/'}`)
  if (status.tcp.enabled) urls.push(`tcp://${host}:${status.tcp.port}`)
  const url = urls[0]
  if (!url) return { urls, posix: undefined, windows: undefined }
  const file = `.dsh-env-${id}.token`
  const posixCwd = cwd ? ` --cwd '${cwd.replace(/'/g, `'\\''`)}'` : ''
  const winCwd = cwd ? ` --cwd '${cwd.replace(/'/g, "''")}'` : ''
  return {
    urls,
    posix:
      `(umask 077 && printf '%s\\n' '${secret}' > ~/${file}) && ` +
      `dsh-env-server connect ${url} --id ${id} --token-file ~/${file}${posixCwd}`,
    windows:
      `Set-Content -Path "$HOME\\${file}" -Value '${secret}'; ` +
      `dsh-env-server.exe connect ${url} --id ${id} --token-file "$HOME\\${file}"${winCwd}`,
  }
}
