// Sharing one Windows session between borrowers (`winuser` accounts with `desktop: 'session'`).
//
// Windows gives an account **one** session at a time, and a second Remote Desktop logon does not
// create a second one: it either joins the session that is already there or pushes it out. So what
// is shared is not the logon but the environment server that runs *inside* that session: every
// borrower opens its own connection to it, and the session lasts until the last of them leaves.
//
// The record below is how a later borrower finds that server. It is written before the logon even
// starts, so a borrower arriving in the meantime waits for the session instead of logging in on its
// own (which would end the other one), and it is never trusted blindly: a record counts only once
// its token has opened a connection. A record that no longer answers is stale, and the caller may
// drop it and log in afresh — that is also how a session left behind by a killed connection is
// recovered.
//
// The record holds the session server's token, like `environments.json` holds the tokens of the
// configured environments, and sits next to the account's stored credentials in the plugin's data
// directory.
import fs from 'node:fs'
import path from 'node:path'
import { errorCode } from '@dsh-environments/protocol'
import type { SessionProbe } from './session-mode.ts'
import type { ServerEnvironment } from '../server/server-env.ts'

/** The session server one Windows-account session is reachable at. */
export interface SessionRecord {
  account: string
  port: number
  token: string
  /** The RDP client that holds the session open (diagnostics only). */
  pid?: number | undefined
  /** When the logon for this record was started. */
  startedAt: number
  /** Last time a borrower reached the server through this record. */
  verifiedAt: number
}

/**
 * How long a record that does not answer yet still counts as "a logon is coming". First logons
 * create the account's profile and can take a minute (`openAccountSession` waits up to 90 s for the
 * server), so a record younger than this is waited for instead of being written off as stale.
 */
export const SESSION_STARTUP_MS = 120_000

/** How often an unanswered record is retried while it is still fresh. */
const RETRY_MS = 1000
/** How often the session table is asked while waiting (one `session status` per probe). */
const PROBE_MS = 5000

/** Where the shared-session record of an account lives (next to its stored credentials). */
export function sessionRecordPath(dataDir: string, account: string): string {
  return path.resolve(dataDir, 'winusers', `${account.toLowerCase()}.session.json`)
}

/** The record of an account, or `undefined` when there is none (or it is unreadable/incomplete). */
export function readSessionRecord(dataDir: string, account: string): SessionRecord | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(sessionRecordPath(dataDir, account), 'utf8'))
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Partial<SessionRecord>
  const port = Number(r.port)
  const startedAt = Number(r.startedAt)
  const verifiedAt = Number(r.verifiedAt)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  if (typeof r.token !== 'string' || r.token === '') return undefined
  if (!Number.isFinite(startedAt)) return undefined
  return {
    account: typeof r.account === 'string' && r.account ? r.account : account,
    port,
    token: r.token,
    ...(Number.isInteger(r.pid) ? { pid: Number(r.pid) } : {}),
    startedAt,
    verifiedAt: Number.isFinite(verifiedAt) ? verifiedAt : startedAt,
  }
}

/** Write a record atomically, so a reader never sees half of one. */
export function writeSessionRecord(dataDir: string, record: SessionRecord): void {
  const file = sessionRecordPath(dataDir, record.account)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2))
  fs.renameSync(tmp, file)
}

/**
 * Drop a record, but only while it still is the one that was read: another borrower may have
 * replaced it with the session it just brought up, and that one must not be thrown away.
 */
export function dropSessionRecord(
  dataDir: string,
  account: string,
  expect: Pick<SessionRecord, 'port' | 'token' | 'startedAt'>,
): boolean {
  const current = readSessionRecord(dataDir, account)
  if (!current) return false
  if (current.port !== expect.port || current.token !== expect.token || current.startedAt !== expect.startedAt)
    return false
  try {
    fs.rmSync(sessionRecordPath(dataDir, account), { force: true })
    return true
  } catch {
    return false
  }
}

/** Whether a record is young enough that its (not yet answering) logon may still be on its way. */
export function recordIsFresh(record: SessionRecord, now = Date.now(), startupMs = SESSION_STARTUP_MS): boolean {
  return now < Math.max(record.verifiedAt, record.startedAt) + startupMs
}

/**
 * Whether the account is logged on in a session of its own. The listener's own station is ignored,
 * exactly like `dsh-env-server`'s `sessions_of`: such a session is what makes a fresh logon
 * reconnect instead of starting the shell we need, so it is the thing a stale-session check looks
 * for.
 */
export function accountSessions(probe: Pick<SessionProbe, 'sessions'> | undefined, account: string): number[] {
  const want = account.toLowerCase()
  return (
    (probe?.sessions ?? [])
      // The bare listener station is not a session, even though it carries the account's name.
      .filter(s => String(s.name ?? '').toLowerCase() !== 'rdp-tcp')
      .filter(s => String(s.user ?? '').toLowerCase() === want)
      .map(s => Number(s.id))
  )
}

/** Mark a record as seen just now, so a live session's record does not look stale to others. */
export function touchSessionRecord(dataDir: string, record: SessionRecord, at = Date.now()): SessionRecord {
  const next = { ...record, verifiedAt: at }
  try {
    writeSessionRecord(dataDir, next)
  } catch {
    // A record is an optimisation: failing to refresh it only costs the next borrower a wait.
  }
  return next
}

export interface AttachSessionOptions {
  dataDir: string
  account: string
  /** Connect to a record's server. Throws with code `AUTH` when the token is not accepted. */
  connect: (record: SessionRecord) => Promise<ServerEnvironment>
  /** Whether the account has a session of its own right now; `undefined` when it cannot be told. */
  hasSession?: (() => Promise<boolean | undefined> | boolean | undefined) | undefined
  signal?: AbortSignal | undefined
  now?: (() => number) | undefined
  sleep?: ((ms: number) => Promise<void>) | undefined
  startupMs?: number | undefined
  retryMs?: number | undefined
  /** Notified about decisions (why a record was taken as shared, waited for or dropped). */
  log?: ((message: string) => void) | undefined
}

/**
 * Reach the session server a record points at; `undefined` when the record is of no use (the caller
 * then logs in afresh, which ends a session left behind by a connection that died — see the module
 * comment). Returning an environment means the session was shared: nothing was logged off.
 */
export async function attachSharedSession({
  dataDir,
  account,
  connect,
  hasSession,
  signal,
  now = Date.now,
  sleep = ms => new Promise<void>(res => setTimeout(res, ms)),
  startupMs = SESSION_STARTUP_MS,
  retryMs = RETRY_MS,
  log,
}: AttachSessionOptions): Promise<ServerEnvironment | undefined> {
  const record = readSessionRecord(dataDir, account)
  if (!record) return undefined
  const note = (message: string) => log?.(`${account}: ${message}`)
  const attempt = async (): Promise<{ env?: ServerEnvironment; auth: boolean; error?: unknown }> => {
    try {
      return { env: await connect(record), auth: false }
    } catch (e) {
      return { auth: errorCode(e) === 'AUTH', error: e }
    }
  }
  const has = async (): Promise<boolean | undefined> => {
    if (!hasSession) return undefined
    try {
      return await hasSession()
    } catch {
      return undefined
    }
  }

  const first = await attempt()
  if (first.env) {
    touchSessionRecord(dataDir, record, now())
    note(`sharing the session server on 127.0.0.1:${record.port}`)
    return first.env
  }
  if (first.auth) {
    // Something else holds that port: the record is not ours any more.
    dropSessionRecord(dataDir, account, record)
    note(`the record's port no longer answers for us; logging in instead`)
    return undefined
  }
  const deadline = Math.max(record.verifiedAt, record.startedAt) + startupMs
  // Giving up drops the record only when this borrow proved it useless. A borrow that was cancelled
  // proves nothing: the session behind the record may be coming up right now, and throwing the record
  // away would leave the next borrower to log in on top of it.
  const giveUp = (why: string, drop = true): undefined => {
    if (drop) dropSessionRecord(dataDir, account, record)
    note(`${why}; logging in instead`)
    return undefined
  }
  if (!recordIsFresh(record, now(), startupMs)) return giveUp('the record is stale')
  if ((await has()) === false) return giveUp('the account has no session left')
  note(`waiting for the session server on 127.0.0.1:${record.port}`)
  let probed = now()
  while (!signal?.aborted && now() < deadline) {
    await sleep(retryMs)
    if (signal?.aborted) break
    const again = await attempt()
    if (again.env) {
      touchSessionRecord(dataDir, record, now())
      note(`sharing the session server on 127.0.0.1:${record.port}`)
      return again.env
    }
    if (again.auth) break
    if (now() - probed >= PROBE_MS) {
      probed = now()
      if ((await has()) === false) break
    }
  }
  if (signal?.aborted) {
    note('the borrow was cancelled')
    return undefined
  }
  return giveUp('the session server never came up')
}
