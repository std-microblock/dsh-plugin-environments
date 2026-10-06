// Factories that open dsh-env-server environments: a local stdio child, or a TCP server.
import { spawn } from 'node:child_process'
import net from 'node:net'
import { childTransport, EnvError, errorCode, errorMessage } from '@dsh-environments/protocol'
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
  host: string
  port: number
  token?: string | undefined
  signal?: AbortSignal | undefined
  timeoutMs?: number
  onClose?: (() => Promise<void> | void) | undefined
}

/** Connect to a running dsh-env-server over TCP. */
export async function openServer({
  id,
  name,
  kind = 'server',
  host,
  port,
  token,
  signal,
  timeoutMs = 15000,
  onClose,
}: OpenServerOptions): Promise<ServerEnvironment> {
  const socket = net.connect({ host, port })
  socket.setNoDelay(true)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new EnvError('ETIMEDOUT', `connecting to ${host}:${port} timed out`))
    }, timeoutMs)
    const onAbort = () => {
      socket.destroy()
      reject(new EnvError('CANCELLED', 'aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    })
    socket.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new EnvError(e.code ?? 'EIO', `cannot connect to ${host}:${port}: ${e.message}`))
    })
  })
  const environment = new ServerEnvironment({ id, name, kind, transport: socket, token, onClose })
  try {
    await environment.open(signal)
  } catch (error) {
    socket.destroy()
    throw error
  }
  return environment
}

export interface ServeProcessOptions {
  binary?: string
  listen?: string
  token?: string
  cwd?: string
  spawnFn?: typeof spawn
}

export interface ServeProcess {
  port: number
  token: string | undefined
  child: ReturnType<typeof spawn>
}

/** Start `dsh-env-server serve` as a child (for tests / managed local servers). */
export function startServeProcess({
  binary,
  listen = '127.0.0.1:0',
  token,
  cwd,
  spawnFn = spawn,
}: ServeProcessOptions = {}): Promise<ServeProcess> {
  const bin = serverBinary(binary)
  const args = ['serve', '--listen', listen, ...(token ? ['--token', token] : []), ...(cwd ? ['--cwd', cwd] : [])]
  const child = spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let buf = ''
  return new Promise((resolve, reject) => {
    let tok = token
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      const t = /DSH_ENV_SERVER token=(\w+)/.exec(buf)
      if (t) tok = t[1]
      const m = /DSH_ENV_SERVER listening=(\S+)/.exec(buf)
      if (m?.[1]) {
        const port = Number(m[1].split(':').pop())
        resolve({ port, token: tok, child })
      }
    })
    child.once('exit', code => reject(new EnvError('EIO', `dsh-env-server exited with ${String(code)}`)))
    child.once('error', reject)
  })
}
