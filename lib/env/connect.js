// Factories that open environments over the supported transports.
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { childTransport, EnvError } from '../protocol/client.js'
import { ServerEnvironment } from './server-env.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Locate the dsh-env-server binary for the host platform. */
export function serverBinary(override) {
  if (override) return override
  const exe = process.platform === 'win32' ? 'dsh-env-server.exe' : 'dsh-env-server'
  const candidates = [
    process.env.DSH_ENV_SERVER_BIN,
    path.join(ROOT, 'bin', `${process.platform}-${process.arch}`, exe),
    path.join(ROOT, 'server', 'target', 'release', exe),
    path.join(ROOT, 'server', 'target', 'debug', exe),
  ].filter(Boolean)
  for (const c of candidates) if (fs.existsSync(c)) return c
  throw new EnvError('ENOENT', `dsh-env-server binary not found (looked in ${candidates.join(', ')})`)
}

/** Start dsh-env-server in stdio mode as a child process and connect to it. */
export async function openLocal({ id, name, cwd, binary, env, signal } = {}) {
  const bin = serverBinary(binary)
  const child = spawn(bin, ['stdio', ...cwd ? ['--cwd', cwd] : []], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...env },
  })
  const stderr = []
  child.stderr.on('data', d => { if (stderr.length < 50) stderr.push(d.toString()) })
  const exited = new Promise(resolve => child.once('exit', resolve))
  const environment = new ServerEnvironment({
    id, name, kind: 'local',
    transport: childTransport(child),
    onClose: async () => {
      try { child.stdin.end() } catch {}
      const t = setTimeout(() => { try { child.kill() } catch {} }, 1500)
      await exited
      clearTimeout(t)
    },
  })
  try {
    await environment.open(signal)
  } catch (error) {
    try { child.kill() } catch {}
    throw new EnvError(error.code ?? 'EIO', `local environment failed to start: ${error.message}${stderr.length ? `\n${stderr.join('')}` : ''}`)
  }
  return environment
}

/** Connect to a running dsh-env-server over TCP. */
export async function openServer({ id, name, kind = 'server', host, port, token, signal, timeoutMs = 15000, onClose }) {
  const socket = net.connect({ host, port })
  socket.setNoDelay(true)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new EnvError('ETIMEDOUT', `connecting to ${host}:${port} timed out`)) }, timeoutMs)
    const onAbort = () => { socket.destroy(); reject(new EnvError('CANCELLED', 'aborted')) }
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve() })
    socket.once('error', e => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(new EnvError(e.code ?? 'EIO', `cannot connect to ${host}:${port}: ${e.message}`)) })
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

/** Start `dsh-env-server serve` as a child (for tests / managed local servers). Resolves { port, token, child }. */
export async function startServeProcess({ binary, listen = '127.0.0.1:0', token, cwd, spawnFn = spawn } = {}) {
  const bin = serverBinary(binary)
  const args = ['serve', '--listen', listen, ...token ? ['--token', token] : [], ...cwd ? ['--cwd', cwd] : []]
  const child = spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let buf = ''
  return new Promise((resolve, reject) => {
    let tok = token
    child.stdout.on('data', d => {
      buf += d.toString()
      const t = /DSH_ENV_SERVER token=(\w+)/.exec(buf)
      if (t) tok = t[1]
      const m = /DSH_ENV_SERVER listening=(\S+)/.exec(buf)
      if (m) {
        const port = Number(m[1].split(':').pop())
        resolve({ port, token: tok, child })
      }
    })
    child.once('exit', code => reject(new EnvError('EIO', `dsh-env-server exited with ${code}`)))
    child.once('error', reject)
  })
}
