// Windows environments that run as a dsh-managed local account on the interactive desktop.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { EnvError, errorCode, errorMessage } from '@dsh-environments/protocol'
import { decodeHostText, runHost } from '../host-process.ts'
import { openServer, serverBinary } from '../server/connect.ts'
import type { ServerEnvironment } from '../server/server-env.ts'
import { runServerElevated, secretPath, type WinuserResult } from './accounts.ts'
import { probeSession } from './session-mode.ts'

/** Stored configuration of a Windows-account environment. */
export interface WinuserConfig {
  account: string
  cwd?: string
  /** `shared` runs on the human's desktop; `private` gives the account its own. */
  desktop?: DesktopMode
}

/** Where an account's windows live. */
export type DesktopMode = 'shared' | 'private' | 'session'

/**
 * Command the RDP session runs as its shell (`alternate shell`), so the environment server starts
 * inside the account's own session without registering anything in its profile.
 */
export function sessionShellCommand(binary: string, port: number, token: string, cwd?: string): string {
  const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s)
  return [
    quote(binary),
    'serve',
    '--listen',
    `127.0.0.1:${port}`,
    '--token',
    token,
    '--once',
    '--cwd',
    quote(cwd ?? '~'),
  ].join(' ')
}

/**
 * Name of the private desktop of an account (`WinSta0\dsh-<account>`). Desktop names are
 * case-insensitive and may not contain a backslash, so the account is slugged.
 */
export function privateDesktopName(account: string): string {
  const safe = account
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .slice(0, 40)
  return `dsh-${safe || 'account'}`
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
  /** `private` starts the account's server (and everything it starts) on its own desktop. */
  desktop?: DesktopMode | undefined
  signal?: AbortSignal | undefined
}

/** Everything `windowsAccountLaunchArgs` needs to build a launcher command line. */
export interface WindowsLaunchArgsOptions {
  account: string
  secretFile: string
  /** Server binary the account should run (already copied where it can read it). */
  binary: string
  port: number
  token: string
  cwd?: string | undefined
  desktop?: DesktopMode | undefined
}

/**
 * Command line of `dsh-env-server winuser launch`, the process that starts (and supervises) the
 * server as the account. `--desktop` makes the launcher create and hold the account's private
 * desktop; it is only accepted together with `--supervise`, which this always passes.
 */
export function windowsAccountLaunchArgs({
  account,
  secretFile,
  binary,
  port,
  token,
  cwd,
  desktop = 'shared',
}: WindowsLaunchArgsOptions): string[] {
  const desktopName = desktop === 'private' ? privateDesktopName(account) : undefined
  return [
    'winuser',
    'launch',
    '--name',
    account,
    '--secret-file',
    secretFile,
    '--supervise',
    ...(cwd ? ['--cwd', cwd] : []),
    ...(desktopName ? ['--desktop', desktopName] : []),
    '--',
    binary,
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
}

/**
 * Accounts already granted the Remote Desktop logon right in this process, so the (elevated)
 * `session allow` runs at most once per account per run.
 */
const allowedAccounts = new Set<string>()

/**
 * Start dsh-env-server as the account and connect to it.
 *
 * `dsh-env-server winuser launch --supervise` (running as the harness user) starts the server with
 * CreateProcessWithLogonW and holds it in a kill-on-close job; it stays alive as our child until
 * the environment closes or the harness exits (its stdin closes), so nothing started as the
 * account outlives the connection.
 *
 * With `desktop: 'private'` the launcher also creates `WinSta0\dsh-<account>`, grants the account
 * access to it and holds it open: a desktop object dies with its last handle, and every process
 * the account starts inherits it, so its windows never mix with the human's.
 *
 * With `desktop: 'session'` the account gets a session of its own instead: a generated `.rdp`
 * logs it in over loopback and starts the server as that session's shell. This is the only mode
 * where the account has a real pointer and real input, and it needs the TermWrap install first
 * (`session.status` reports whether it is available).
 */
async function openAccountSession(
  base: { id: string; name?: string | undefined; signal?: AbortSignal | undefined },
  account: string,
  secret: string,
  bin: string,
  port: number,
  token: string,
  cwd?: string,
): Promise<ServerEnvironment> {
  const status = await probeSession(base.signal)
  if (!status.ready) {
    throw new EnvError('UNSUPPORTED', `this machine cannot host a separate session yet: ${status.reasons.join('; ')}`)
  }
  const rdp = path.join(os.tmpdir(), `dsh-session-${account}-${process.pid}-${Date.now()}.rdp`)
  const shell = sessionShellCommand(bin, port, token, cwd)
  // The logon right is per account and needs administrator approval. Ask once per account per
  // run: membership does not change, and a UAC prompt on every connect would be obnoxious.
  if (!allowedAccounts.has(account)) {
    await runServerElevated(['session', 'allow', '--account', account])
    allowedAccounts.add(account)
  }
  const written = await runHost(
    serverBinary(),
    [
      'winuser',
      'rdp-file',
      '--name',
      account,
      '--secret-file',
      secret,
      '--out',
      rdp,
      '--shell',
      shell,
      '--width',
      '1280',
      '--height',
      '800',
    ],
    { timeoutMs: 30000, signal: base.signal },
  )
  if (written.code !== 0) {
    throw new EnvError('EIO', `could not write the session file: ${written.stderr.trim()}`)
  }
  // Keep the client running: a disconnected session stops rendering, so screenshots would go
  // black. Killing it is what ends the session.
  const client = spawn('mstsc.exe', [rdp], { stdio: 'ignore', windowsHide: true })
  client.on('error', () => {})
  let lastError: unknown
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    if (base.signal?.aborted) break
    try {
      const env = await openServer({
        id: base.id,
        name: base.name,
        kind: 'winuser',
        host: '127.0.0.1',
        port,
        token,
        signal: base.signal,
        timeoutMs: 3000,
        onClose: () => {
          client.kill()
        },
      })
      env.account = account
      env.desktopName = `session:${account}`
      return env
    } catch (e) {
      lastError = e
      await new Promise(res => setTimeout(res, 500))
    }
  }
  client.kill()
  fs.rmSync(rdp, { force: true })
  throw new EnvError(
    'ETIMEDOUT',
    `the session for ${account} did not come up${lastError === undefined ? '' : `: ${errorMessage(lastError)}`}`,
  )
}
export async function openWindowsAccount({
  id,
  name,
  account,
  dataDir,
  cwd,
  desktop = 'shared',
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
  if (desktop === 'session') {
    return await openAccountSession({ id, name, signal }, account, secret, bin, port, token, cwd)
  }
  const desktopName = desktop === 'private' ? privateDesktopName(account) : undefined
  const args = windowsAccountLaunchArgs({
    account,
    secretFile: secret,
    binary: bin,
    port,
    token,
    cwd,
    desktop,
  })
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
      env.desktopName = desktopName
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
