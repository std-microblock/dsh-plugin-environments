// Factories that open dsh-env-server environments: a local stdio child, or a network server (TCP / WebSocket).
import { spawn } from 'node:child_process'
import net from 'node:net'
import {
  childTransport,
  EnvError,
  errorCode,
  errorMessage,
  generateSecret,
  secureInitiate,
  wsConnect,
  type Transport,
} from '@dsh-environments/protocol'
import { HOST_TARGET, serverBinaryFile, serverExeName } from '../../server-binary.ts'
import type { EnvironmentKind } from '../types.ts'
import { ServerEnvironment } from './server-env.ts'

export const SERVER_EXE = serverExeName()

/** Locate (unpacking if needed) the dsh-env-server binary for the host platform. */
export function serverBinary(override?: string): string {
  return serverBinaryFile(HOST_TARGET, override)
}

export interface OpenLocalOptions {
  id: string
  name?: string | undefined
  cwd?: string | undefined
  binary?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  signal?: AbortSignal | undefined
}

/** Start dsh-env-server in stdio mode as a child process and connect to it. */
export async function openLocal({ id, name, cwd, binary, env, signal }: OpenLocalOptions): Promise<ServerEnvironment> {
  const bin = serverBinary(binary)
  const child = spawn(bin, ['stdio', ...(cwd ? ['--cwd', cwd] : [])], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...env },
  })
  const stderr: string[] = []
  child.stderr.on('data', (d: Buffer) => {
    if (stderr.length < 50) stderr.push(d.toString())
  })
  const exited = new Promise(resolve => child.once('exit', resolve))
  const environment = new ServerEnvironment({
    id,
    name,
    kind: 'local',
    transport: childTransport(child),
    onClose: async () => {
      try {
        child.stdin.end()
      } catch {
        // already closed
      }
      const t = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // already exited
        }
      }, 1500)
      await exited
      clearTimeout(t)
    },
  })
  try {
    await environment.open(signal)
  } catch (error) {
    try {
      child.kill()
    } catch {
      // already exited
    }
    throw new EnvError(
      errorCode(error) ?? 'EIO',
      `local environment failed to start: ${errorMessage(error)}${stderr.length ? `\n${stderr.join('')}` : ''}`,
    )
  }
  return environment
}

export interface OpenServerOptions {
  id: string
  name?: string | undefined
  kind?: EnvironmentKind
  /** `tcp://host:port`, `ws://host:port/path` or `wss://...`; alternative to host + port. */
  url?: string | undefined
  host?: string | undefined
  port?: number | undefined
  /** The server's shared secret (keys the secure channel). */
  token?: string | undefined
  signal?: AbortSignal | undefined
  timeoutMs?: number
  onClose?: (() => Promise<void> | void) | undefined
}

/** Normalised dial target of a `server` environment. */
export type DialTarget = { kind: 'tcp'; host: string; port: number } | { kind: 'ws'; url: string }

/** Parse `host:port`, `tcp://host:port`, `ws://...` or `wss://...`. */
export function parseServerUrl(url: string): DialTarget {
  const s = url.trim()
  if (/^wss?:\/\//i.test(s)) {
    new URL(s) // validates
    return { kind: 'ws', url: s }
  }
  const m = /^(?:tcp:\/\/)?(\[[^\]]+\]|[^:/]+):(\d+)\/?$/i.exec(s)
  if (!m?.[1] || !m[2])
    throw new EnvError('EINVAL', `invalid server address "${url}" (use host:port, tcp://, ws:// or wss://)`)
  return { kind: 'tcp', host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) }
}

/** Open a plain TCP connection. */
export function dialTcp(host: string, port: number, signal?: AbortSignal, timeoutMs = 15000): Promise<net.Socket> {
  const socket = net.connect({ host, port })
  socket.setNoDelay(true)
  return new Promise<net.Socket>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new EnvError('ETIMEDOUT', `connecting to ${host}:${port} timed out`))
    }, timeoutMs)
    const onAbort = () => {
      clearTimeout(timer)
      socket.destroy()
      reject(new EnvError('CANCELLED', 'aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(socket)
    })
    socket.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new EnvError(e.code ?? 'EIO', `cannot connect to ${host}:${port}: ${e.message}`))
    })
  })
}

/** Dial a server and run the secure-channel handshake; resolves to the encrypted transport. */
export async function dialSecure(
  target: DialTarget,
  secret: string,
  { signal, timeoutMs = 15000 }: { signal?: AbortSignal | undefined; timeoutMs?: number } = {},
): Promise<Transport> {
  const raw: Transport =
    target.kind === 'ws'
      ? await wsConnect(target.url, { signal, timeoutMs })
      : await dialTcp(target.host, target.port, signal, timeoutMs)
  try {
    return await secureInitiate(raw, { secret, signal })
  } catch (e) {
    raw.destroy?.()
    throw e
  }
}

/** Connect to a running dsh-env-server over TCP or WebSocket (secure channel keyed by `token`). */
export async function openServer({
  id,
  name,
  kind = 'server',
  url,
  host,
  port,
  token,
  signal,
  timeoutMs = 15000,
  onClose,
}: OpenServerOptions): Promise<ServerEnvironment> {
  if (!token) throw new EnvError('EINVAL', 'a shared secret (token) is required to connect to dsh-env-server')
  const target: DialTarget = url ? parseServerUrl(url) : { kind: 'tcp', host: host ?? '', port: Number(port) }
  const transport = await dialSecure(target, token, { signal, timeoutMs })
  const environment = new ServerEnvironment({ id, name, kind, transport, onClose })
  try {
    await environment.open(signal)
  } catch (error) {
    transport.destroy?.()
    throw error
  }
  return environment
}

export interface ServeProcessOptions {
  binary?: string
  /** `host:port`, `tcp://...` or `ws://host:port/path` */
  listen?: string
  token?: string
  cwd?: string
  /** Pass `--lifeline --exit-idle`. */
  lifeline?: boolean
  spawnFn?: typeof spawn
}

export interface ServeProcess {
  port: number
  /** `ws://...` when listening on WebSocket. */
  url: string | undefined
  token: string
  pid: number | undefined
  child: ReturnType<typeof spawn>
}

/** Start `dsh-env-server serve` as a child (for tests / managed local servers). The secret goes through stdin. */
export function startServeProcess({
  binary,
  listen = '127.0.0.1:0',
  token = generateSecret(),
  cwd,
  lifeline = false,
  spawnFn = spawn,
}: ServeProcessOptions = {}): Promise<ServeProcess> {
  const bin = serverBinary(binary)
  const args = [
    'serve',
    '--listen',
    listen,
    '--token-stdin',
    ...(lifeline ? ['--lifeline', '--exit-idle'] : []),
    ...(cwd ? ['--cwd', cwd] : []),
  ]
  const child = spawnFn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stdin?.write(`${token}\n`)
  if (!lifeline) child.stdin?.end()
  let buf = ''
  return new Promise((resolve, reject) => {
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      const m = /DSH_ENV_SERVER listening=(\S+)/.exec(buf)
      if (m?.[1]) {
        const port = Number(m[1].split(':').pop())
        const pid = /DSH_ENV_SERVER pid=(\d+)/.exec(buf)?.[1]
        resolve({
          port,
          url: /DSH_ENV_SERVER url=(\S+)/.exec(buf)?.[1],
          token,
          pid: pid ? Number(pid) : undefined,
          child,
        })
      }
    })
    child.once('exit', code => reject(new EnvError('EIO', `dsh-env-server exited with ${String(code)}`)))
    child.once('error', reject)
  })
}
