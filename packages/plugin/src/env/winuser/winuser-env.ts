// Windows environments that run as a dsh-managed local account on the interactive desktop.
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { EnvError, errorCode } from '@dsh-environments/protocol'
import { runHost } from '../host-process.ts'
import { openServer, SERVER_EXE, serverBinary } from '../server/connect.ts'
import type { ServerEnvironment } from '../server/server-env.ts'
import { secretPath, type WinuserResult } from './accounts.ts'

/** Stored configuration of a Windows-account environment. */
export interface WinuserConfig {
  account: string
  cwd?: string
}

/** Copy the server binary to a location every local account can execute. */
export function sharedBinary(binary?: string): string {
  const src = serverBinary(binary)
  const base = process.env['ProgramData'] ?? 'C:\\ProgramData'
  const dir = path.join(base, 'dsh-env')
  const dst = path.join(dir, SERVER_EXE)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const s = fs.statSync(src)
    const d = fs.existsSync(dst) ? fs.statSync(dst) : undefined
    if (!d || d.size !== s.size || d.mtimeMs < s.mtimeMs) fs.copyFileSync(src, dst)
    return dst
  } catch {
    return src
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
    s.on('error', reject)
  })
}

export interface OpenWindowsAccountOptions {
  id: string
  name?: string | undefined
  account: string
  dataDir: string
  cwd?: string | undefined
  signal?: AbortSignal | undefined
}

/** Start dsh-env-server as the account on the interactive desktop and connect to it. */
export async function openWindowsAccount({
  id,
  name,
  account,
  dataDir,
  cwd,
  signal,
}: OpenWindowsAccountOptions): Promise<ServerEnvironment> {
  const secret = secretPath(dataDir, account)
  if (!fs.existsSync(secret)) {
    throw new EnvError('ENOENT', `no stored credentials for account ${account}; recreate it from the Environments page`)
  }
  const bin = sharedBinary()
  const port = await freePort()
  const token = crypto.randomBytes(24).toString('hex')
  const args = [
    'winuser',
    'launch',
    '--name',
    account,
    '--secret-file',
    secret,
    ...(cwd ? ['--cwd', cwd] : []),
    '--',
    bin,
    'serve',
    '--listen',
    `127.0.0.1:${port}`,
    '--token',
    token,
    '--once',
    ...(cwd ? ['--cwd', cwd] : []),
  ]
  const r = await runHost(serverBinary(), args, { timeoutMs: 30000 })
  let launched: WinuserResult | undefined
  try {
    launched = JSON.parse(r.stdout.toString().trim().split(/\r?\n/).pop() ?? '') as WinuserResult
  } catch {
    // reported below
  }
  if (!launched?.ok) {
    throw new EnvError(
      'EIO',
      `could not start a session as ${account}: ${launched?.error ?? (r.stderr || r.stdout.toString())}`,
    )
  }
  const deadline = Date.now() + 30000
  let lastError: unknown
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new EnvError('CANCELLED', 'aborted')
    try {
      const env = await openServer({
        id,
        name,
        kind: 'winuser',
        host: '127.0.0.1',
        port,
        token,
        signal,
        timeoutMs: 3000,
      })
      env.account = account
      env.serverPid = launched.pid
      return env
    } catch (e) {
      lastError = e
      if (errorCode(e) === 'AUTH') throw e
      await new Promise(res => setTimeout(res, 400))
    }
  }
  throw new EnvError(
    'ETIMEDOUT',
    `the server started as ${account} did not accept connections: ${lastError instanceof Error ? lastError.message : ''}`,
  )
}
