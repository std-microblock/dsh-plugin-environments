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
import { listWindowsAccounts, runServerElevated, secretPath, type WinuserResult } from './accounts.ts'
import { probeSession } from './session-mode.ts'
import {
  accountSessions,
  attachSharedSession,
  dropSessionRecord,
  readSessionRecord,
  writeSessionRecord,
  type SessionRecord,
} from './session-share.ts'

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
 * Command the session's shell runs: the environment server, started inside the account's own
 * session. It is written to the account's `Winlogon\Shell` for the logon, so nothing has to be
 * registered in the account's profile.
 *
 * The server is the shared thing: Windows gives the account one session at a time, so every
 * borrower of this environment connects to *this* server instead of logging in again. `--exit-idle`
 * (rather than `--once`) is what makes that work: the server serves any number of clients and exits
 * when the last of them leaves, which together with `--end-session` ends the session — a session
 * left behind would swallow the next logon.
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
    '--exit-idle',
    // Windows gives a console application started as the session's shell a console window: without
    // this it would sit on the account's desktop, in the way of everything the agent does.
    '--no-console',
    // Winlogon starts the shell on a desktop of its own, and every session desktop is called
    // `Default`, so a capture would otherwise read that empty one instead of the session's windows.
    '--input-desktop',
    // Windows does not reliably end the session when its shell exits (it can sit at the logon
    // screen instead). A session left behind is worse than useless: the next logon reconnects to it
    // and the shell never runs again.
    '--end-session',
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
 * Accounts whose Remote Desktop logon right this run already granted, as name → the SID it was
 * granted for. The grant lives on the account SID, so keying it by name alone is wrong: an account
 * that is deleted and re-created under the same name comes back with a new SID, no group
 * membership and no listener ACE, and the logon is then refused during CredSSP ("access denied",
 * which reads like a wrong password).
 */
const allowedAccounts = new Map<string, string>()

/** The account's SID, or null when this machine has no such dsh-managed account. */
async function accountSidOf(account: string): Promise<string | null> {
  const accounts = await listWindowsAccounts().catch(() => [])
  const hit = accounts.find(a => a.name.toLowerCase() === account.toLowerCase())
  return hit?.sid ?? null
}

/** Grant (elevated) the logon right at most once per SID per run. */
async function ensureAllowed(account: string, sid: string): Promise<void> {
  if (allowedAccounts.get(account) === sid) return
  await runServerElevated(['session', 'allow', '--account', account])
  allowedAccounts.set(account, sid)
}

/**
 * Run one open of an account after the previous one finished.
 *
 * Borrowers arriving together are what this protects: the first writes the session record just
 * before it logs in, and the second then finds it and joins that session. Without it, both would
 * log in at once — and Windows gives the account one session, so the second logon would only push
 * the first one's session out.
 */
const pendingOpens = new Map<string, Promise<unknown>>()
function serializeByAccount<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = pendingOpens.get(key) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tracked = run.then(
    () => undefined,
    () => undefined,
  )
  pendingOpens.set(key, tracked)
  void tracked.then(() => {
    if (pendingOpens.get(key) === tracked) pendingOpens.delete(key)
  })
  return run
}

/**
 * Open (or join) the account's own Windows session.
 *
 * With `desktop: 'session'` the account gets a session of its own: a headless RDP client logs it in
 * over loopback, the account's own logon shell starts the server inside that session, and the client
 * stays connected to keep it rendering. This is the only mode where the account has a real pointer
 * and real input, and it needs the TermWrap install first (`session.status` reports whether it is
 * available).
 *
 * Windows gives the account **one** session at a time, so this is shared rather than exclusive: a
 * session that is already up is joined through its record (`session-share.ts`) and nothing is logged
 * in — let alone logged off. Only when no session server answers does this log the account in, and
 * the logon path is what recovers a session left behind by a connection that died.
 */
async function openAccountSession(
  base: { id: string; name?: string | undefined; signal?: AbortSignal | undefined },
  {
    dataDir,
    account,
    secret,
    bin,
    cwd,
  }: { dataDir: string; account: string; secret: string; bin: string; cwd?: string },
): Promise<ServerEnvironment> {
  const signal = base.signal
  // Note: no `onClose` — the RDP client that holds the session must outlive this connection, because
  // other borrowers may be attached to the same session server.
  const sessionOfRecord = (record: { port: number; token: string }): Promise<ServerEnvironment> =>
    openServer({
      id: base.id,
      name: base.name,
      kind: 'winuser',
      host: '127.0.0.1',
      port: record.port,
      token: record.token,
      signal,
      timeoutMs: 3000,
    })
  const startClient = (shell: string) => {
    const state = {
      child: spawn(
        serverBinary(),
        [
          'winuser',
          'session',
          '--name',
          account,
          '--secret-file',
          secret,
          '--shell',
          shell,
          '--width',
          '1280',
          '--height',
          '800',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      ),
      connected: false,
      // The account is still logged on somewhere, so this logon would only rejoin that session.
      busy: false,
      log: '',
    }
    state.child.stdout.setEncoding('utf8')
    state.child.stdout.on('data', (chunk: string) => {
      state.log += chunk
      if (chunk.includes('"connected":true')) state.connected = true
      if (chunk.includes('"code":"session-busy"')) state.busy = true
    })
    state.child.stderr.setEncoding('utf8')
    state.child.stderr.on('data', (chunk: string) => {
      state.log += chunk
    })
    state.child.on('error', e => {
      state.log += errorMessage(e)
    })
    return state
  }
  // A logon client that dies leaves the session behind as a disconnected one, and a disconnected
  // session stops drawing, which turns every screenshot black. RDP rejoins the same session, so a
  // fresh client brings the windows and the rendering back. Bounded, because a session whose client
  // keeps dying must not be restarted forever.
  let restarts = 0
  let supervising = false
  const superviseLogonClient = (forRecord: SessionRecord) => {
    if (supervising) return
    supervising = true
    const tick = async () => {
      if (base.signal?.aborted || restarts >= 5) return
      const current = readSessionRecord(dataDir, account)
      if (!current || current.port !== forRecord.port || current.token !== forRecord.token) return
      if (!fs.existsSync(secret)) return
      let sessions: { id: number; state: string }[]
      try {
        const probe = await probeSession(signal)
        const want = account.toLowerCase()
        sessions = (probe?.sessions ?? [])
          .filter(s => String(s.name ?? '').toLowerCase() !== 'rdp-tcp')
          .filter(s => String(s.user ?? '').toLowerCase() === want)
      } catch {
        return
      }
      // No session left means the server ended it cleanly; anything other than `active` means the
      // session is still there but has stopped drawing, which is the state that turns screenshots
      // black even when the client process is technically still alive.
      if (sessions.length === 0) return
      const drawing = sessions.every(s => String(s.state ?? '').toLowerCase() === 'active')
      if (drawing && current.pid && alive(current.pid)) return
      restarts++
      forRecord.pid = startClient(sessionShellCommand(bin, forRecord.port, forRecord.token, cwd)).child.pid
      try {
        writeSessionRecord(dataDir, forRecord)
      } catch {
        // the record only decides whether a borrower waits or logs in itself
      }
    }
    const timer = setInterval(() => void tick(), 5000)
    if (typeof timer.unref === 'function') timer.unref()
  }
  const shared = await attachSharedSession({
    dataDir,
    account,
    signal,
    connect: async record => {
      const env = await sessionOfRecord(record)
      env.account = account
      env.desktopName = `session:${account}`
      return env
    },
    hasSession: async () => accountSessions(await probeSession(signal), account).length > 0,
  })
  if (shared) {
    // Joining a session whose logon client is already gone would share a session that never repaints.
    const attached = readSessionRecord(dataDir, account)
    if (attached) superviseLogonClient(attached)
    return shared
  }

  const status = await probeSession(signal)
  if (!status.ready) {
    throw new EnvError('UNSUPPORTED', `this machine cannot host a separate session yet: ${status.reasons.join('; ')}`)
  }
  const port = await freePort()
  const token = crypto.randomBytes(24).toString('hex')
  const shell = sessionShellCommand(bin, port, token, cwd)
  const record: SessionRecord = { account, port, token, startedAt: Date.now(), verifiedAt: Date.now() }
  // The record goes down before the logon: a borrower arriving while this one is still logging in
  // finds it, waits for the server instead of logging in itself, and so never ends this session.
  writeSessionRecord(dataDir, record)
  // The logon right needs administrator approval, so ask at most once per SID per run (a UAC prompt
  // on every connect would be obnoxious). A missing account is left to the logon itself, which
  // reports "create the account again" instead of a pointless approval dialog.
  const sid = await accountSidOf(account)
  if (sid !== null) await ensureAllowed(account, sid)
  // The logon itself is a headless RDP client (see crates/dsh-env-server/src/rdp.rs): it points the
  // account's own logon shell at `shell`, so our server starts inside the new session, and then
  // holds the connection open. A disconnected session stops rendering, which would make every
  // screenshot black. The client is left alone once the session is up: it is what keeps the session
  // alive for the other borrowers, and the server ends the session (and the client with it) when the
  // last connection is gone.
  let session = startClient(shell)
  if (session.child.pid) {
    record.pid = session.child.pid
    try {
      writeSessionRecord(dataDir, record)
    } catch {
      // the record only decides whether a borrower waits or logs in itself
    }
  }
  let lastError: unknown
  // Up to three attempts: one for a stale session of the account that has to be ended, and one
  // after re-granting the logon right (the account may have been re-created under this name since
  // the grant, which gives it a new SID and no right at all).
  let endedStale = false
  let reAllowed = false
  for (let attempt = 0; attempt < 3 && !base.signal?.aborted; attempt++) {
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
          // No `onClose`: the client keeps the session alive for anyone else who joins it, and the
          // server ends the session by itself once its last connection is gone.
        })
        env.account = account
        env.desktopName = `session:${account}`
        superviseLogonClient(record)
        return env
      } catch (e) {
        lastError = e
        // Waiting out the deadline only delays the report when the logon is already over: the client
        // exits on a refusal (wrong password, no logon right) or on a busy account.
        if ((session.child.exitCode !== null || session.busy) && !session.connected) break
        await new Promise(res => setTimeout(res, 500))
      }
    }
    if (session.busy && !endedStale) {
      endedStale = true
      session.child.kill()
      // Reaching this means the account is logged on in a session that has no server of ours to join
      // (every running session is tried first, see `attachSharedSession`): a session left behind by a
      // connection that died, or a login someone did by hand. Either way it swallows this logon — RDP
      // reconnects to it and the shell we need never runs — so it has to go. That needs administrator
      // rights, so the prompt is acceptable here.
      await runServerElevated(['session', 'logoff', '--account', account])
      session = startClient(shell)
      continue
    }
    // "access denied" during CredSSP means the account was not let through. The usual cause is a
    // re-created account (new SID, its right gone), so re-grant it once and try again.
    if (!reAllowed && /access denied/i.test(session.log)) {
      const fresh = await accountSidOf(account)
      if (fresh !== null) {
        reAllowed = true
        allowedAccounts.delete(account)
        session.child.kill()
        await ensureAllowed(account, fresh)
        session = startClient(shell)
        continue
      }
    }
    break
  }
  session.child.kill()
  // No session came up: the record would only make the next borrower wait for something that is not
  // coming, so it goes (unless another logon already replaced it with its own).
  dropSessionRecord(dataDir, account, record)
  const detail = session.log.trim().split('\n').filter(Boolean).at(-1)
  // "access denied" from CredSSP says nothing about the cause: it is shown both for a missing logon
  // right and for a password that no longer matches, so name the two things that actually help.
  const hint = /access denied/i.test(session.log)
    ? ' (the account refused the logon during CredSSP: create it again from the Environments page, which resets its password and re-grants the Remote Desktop logon right)'
    : ''
  throw new EnvError(
    'ETIMEDOUT',
    `the session for ${account} did not come up${lastError === undefined ? '' : `: ${errorMessage(lastError)}`}${
      detail ? ` (${detail})` : ''
    }${hint}`,
  )
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Open an environment that runs as a dsh-managed local account.
 *
 * `desktop: 'shared'` (the default) and `'private'`: `dsh-env-server winuser launch --supervise`
 * (running as the harness user) starts the server with CreateProcessWithLogonW and holds it in a
 * kill-on-close job; it stays alive as our child until the environment closes or the harness exits
 * (its stdin closes), so nothing started as the account outlives the connection. With `'private'`
 * the launcher also creates `WinSta0\dsh-<account>`, grants the account access to it and holds it
 * open: a desktop object dies with its last handle, and every process the account starts inherits
 * it, so its windows never mix with the human's.
 *
 * `desktop: 'session'`: a session of the account's own (`openAccountSession`), shared by everyone
 * who borrows it.
 */
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
  if (desktop === 'session') {
    // One open per account at a time: the second borrower must find the record the first has just
    // written and join that session instead of logging in (and ending it) on its own.
    return await serializeByAccount(`${dataDir}:${account.toLowerCase()}`, () =>
      openAccountSession({ id, name, signal }, { dataDir, account, secret, bin, cwd }),
    )
  }
  const port = await freePort()
  const token = crypto.randomBytes(24).toString('hex')
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
