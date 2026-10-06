// Windows environments that run as a dsh-managed local account on the interactive desktop.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { EnvError, errorCode, errorMessage } from '@dsh-environments/protocol'
import { decodeHostText } from '../host-process.ts'
import { openServer, serverBinary } from '../server/connect.ts'
import type { ServerEnvironment } from '../server/server-env.ts'
import { secretPath, type WinuserResult } from './accounts.ts'

/** Stored configuration of a Windows-account environment. */
export interface WinuserConfig {
  account: string
  cwd?: string
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Copy the server binary to a location every local account can execute (the plugin's own copy
 * usually lives in the harness user's profile, which other accounts cannot enter).
 * `%ProgramData%\dsh-env` inherits "Users: read & execute"; the file name carries the content
 * hash, so a running copy never has to be overwritten and a tampered one is replaced.
 */
export function sharedBinary(binary?: string, base = process.env['ProgramData'] ?? 'C:\\ProgramData'): string {
  const src = serverBinary(binary)
  const dir = path.join(base, 'dsh-env')
  try {
    const hash = sha256(src)
    const dst = path.join(dir, `dsh-env-server-${hash.slice(0, 16)}.exe`)
    fs.mkdirSync(dir, { recursive: true })
    if (!fs.existsSync(dst) || sha256(dst) !== hash) {
      const tmp = `${dst}.${process.pid}.tmp`
      fs.copyFileSync(src, tmp)
      fs.renameSync(tmp, dst)
    }
    for (const f of fs.readdirSync(dir)) {
      if (/^dsh-env-server.*\.exe$/i.test(f) && path.join(dir, f) !== dst) {
        try {
          fs.rmSync(path.join(dir, f), { force: true })
        } catch {
          // still running for another environment
        }
      }
    }
    return dst
  } catch (e) {
    throw new EnvError(
      'EACCES',
      `cannot place the server binary where other accounts can run it (${dir}): ${errorMessage(e)}`,
    )
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

/** First stdout line of the launcher (or everything it printed before exiting). */
function firstLine(child: ChildProcessWithoutNullStreams, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    const finish = (fn: () => void) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      child.stdout.off('data', onData)
      child.off('close', onClose)
      fn()
    }
    const text = () => decodeHostText(Buffer.concat(out))
    const onData = (d: Buffer) => {
      out.push(d)
      const s = text()
      const nl = s.indexOf('\n')
      if (nl >= 0) finish(() => resolve(s.slice(0, nl).trim()))
    }
    const onClose = () =>
      finish(() => resolve(text().trim() || decodeHostText(Buffer.concat(err)).trim() || 'launcher exited'))
    const onAbort = () => finish(() => reject(new EnvError('CANCELLED', 'aborted')))
    const timer = setTimeout(
      () => finish(() => reject(new EnvError('ETIMEDOUT', 'starting the account session timed out'))),
      timeoutMs,
    )
    child.stdout.on('data', onData)
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('close', onClose)
    child.once('error', e => finish(() => reject(new EnvError('EIO', e.message))))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** End a supervising launcher: closing its stdin makes it kill the account's process tree. */
async function stopLauncher(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(r => child.once('close', r))
  child.stdin.end()
  const t = setTimeout(() => child.kill(), 3000)
  await exited
  clearTimeout(t)
}

export interface OpenWindowsAccountOptions {
  id: string
  name?: string | undefined
  account: string
  dataDir: string
  cwd?: string | undefined
  signal?: AbortSignal | undefined
}

/**
 * Start dsh-env-server as the account on the interactive desktop and connect to it.
 *
 * `dsh-env-server winuser launch --supervise` (running as the harness user) starts the server with
 * CreateProcessWithLogonW and holds it in a kill-on-close job; it stays alive as our child until
 * the environment closes or the harness exits (its stdin closes), so nothing started as the
 * account outlives the connection.
 */
export async function openWindowsAccount({
  id,
  name,
  account,
  dataDir,
  cwd,
  signal,
}: OpenWindowsAccountOptions): Promise<ServerEnvironment> {
  if (process.platform !== 'win32') throw new EnvError('UNSUPPORTED', 'Windows accounts are only available on Windows')
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
    '--supervise',
    ...(cwd ? ['--cwd', cwd] : []),
    '--',
    bin,
    'serve',
    '--listen',
    `127.0.0.1:${port}`,
    '--token',
    token,
    '--once',
    // Without a configured directory start in the account's own profile.
    '--cwd',
    cwd ?? '~',
  ]
  const launcher = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  launcher.stdin.on('error', () => {})
  let launched: WinuserResult | undefined
  let line = ''
  try {
    // The first logon of an account creates its profile, which can take a while.
    line = await firstLine(launcher, 120000, signal)
    launched = JSON.parse(line) as WinuserResult
  } catch (e) {
    await stopLauncher(launcher)
    if (errorCode(e)) throw e
  }
  if (!launched?.ok) {
    await stopLauncher(launcher)
    throw new EnvError('EIO', `could not start a session as ${account}: ${launched?.error ?? line}`)
  }
  const deadline = Date.now() + 30000
  let lastError: unknown
  while (Date.now() < deadline && launcher.exitCode === null) {
    if (signal?.aborted) {
      await stopLauncher(launcher)
      throw new EnvError('CANCELLED', 'aborted')
    }
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
        onClose: () => stopLauncher(launcher),
      })
      env.account = account
      env.serverPid = launched.pid
      return env
    } catch (e) {
      lastError = e
      if (errorCode(e) === 'AUTH') break
      await new Promise(res => setTimeout(res, 300))
    }
  }
  await stopLauncher(launcher)
  throw new EnvError(
    errorCode(lastError) === 'AUTH' ? 'AUTH' : 'ETIMEDOUT',
    `the server started as ${account} did not accept connections: ${lastError === undefined ? 'it exited' : errorMessage(lastError)}`,
  )
}
