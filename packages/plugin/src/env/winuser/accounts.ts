// Managing dsh-owned local Windows accounts (create/delete/grant run elevated).
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EnvError } from '@dsh-environments/protocol'
import { decodeHostText, runHost, type RunHostResult } from '../host-process.ts'
import { serverBinary } from '../server/connect.ts'

export const ACCOUNT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/

/** Where the DPAPI-protected password of an account is stored. */
export function secretPath(dataDir: string, name: string): string {
  return path.resolve(dataDir, 'winusers', `${name}.secret`)
}

/** JSON line printed by `dsh-env-server winuser ...`. */
export interface WinuserResult {
  ok: boolean
  error?: string
  pid?: number
  [key: string]: unknown
}

/**
 * Run a dsh-env-server winuser command elevated. The command and its output redirection live in a
 * temporary .cmd script, so no quoting passes through cmd /c; the server binary itself raises the
 * UAC consent dialog (`dsh-env-server elevate`) and waits for the elevated process to finish.
 *
 * No third-party elevation tool is used: `gsudo` and friends elevate by replacing the token of the
 * calling process, which fails on a redirected console (the harness host) with "Failed to
 * substitute token", while the shell's `runas` verb needs nothing but an interactive session.
 */
async function runElevated(
  args: string[],
  { timeoutMs = 180000 }: { timeoutMs?: number } = {},
): Promise<WinuserResult> {
  if (process.platform !== 'win32')
    throw new EnvError('UNSUPPORTED', 'Windows accounts can only be managed on Windows hosts')
  const bin = serverBinary()
  const id = crypto.randomUUID()
  const out = path.join(os.tmpdir(), `dsh-env-elev-${id}.json`)
  const script = path.join(os.tmpdir(), `dsh-env-elev-${id}.cmd`)
  const quote = (a: string) => `"${a.replace(/"/g, '""')}"`
  fs.writeFileSync(
    script,
    `@echo off\r\nchcp 65001 >nul\r\n${quote(bin)} ${args.map(quote).join(' ')} > ${quote(out)} 2>&1\r\n`,
  )
  let r: RunHostResult
  try {
    r = await runHost(bin, ['elevate', '--', 'cmd.exe', '/d', '/c', script], { timeoutMs })
  } finally {
    fs.rmSync(script, { force: true })
  }
  let text = ''
  try {
    // UTF-8 JSON from the helper, possibly after code-page text from tools it ran.
    text = decodeHostText(fs.readFileSync(out))
  } catch {
    // no output: cancelled
  }
  fs.rmSync(out, { force: true })
  if (!text.trim()) {
    throw new EnvError(
      'EACCES',
      `administrator approval was cancelled or failed${r.stderr.trim() ? `: ${r.stderr.trim()}` : ''}`,
    )
  }
  let parsed: WinuserResult
  try {
    parsed = JSON.parse(text.trim().split(/\r?\n/).pop() ?? '') as WinuserResult
  } catch {
    throw new EnvError('EIO', `unexpected output: ${text.trim()}`)
  }
  if (!parsed.ok) throw new EnvError('EIO', parsed.error ?? 'operation failed')
  return parsed
}

/**
 * Run any `dsh-env-server` subcommand elevated (a UAC consent dialog). Used by the account
 * commands and by the TermWrap installer, which both have to touch machine-wide state.
 */
export async function runServerElevated(args: string[], opts: { timeoutMs?: number } = {}): Promise<WinuserResult> {
  return await runElevated(args, opts)
}

/** One account reported by `dsh-env-server winuser list`. */ export interface WindowsAccount {
  name: string
  sid: string | null
  /** Registered profile directory; null before the account's first logon. */
  profile: string | null
  profileExists: boolean
  [key: string]: unknown
}

export async function listWindowsAccounts(): Promise<WindowsAccount[]> {
  if (process.platform !== 'win32') return []
  const r = await runHost(serverBinary(), ['winuser', 'list'], { timeoutMs: 20000 })
  try {
    return JSON.parse(decodeHostText(r.stdout)) as WindowsAccount[]
  } catch {
    return []
  }
}

export async function createWindowsAccount(
  name: string,
  { dataDir, grantPaths = [] }: { dataDir: string; grantPaths?: string[] },
): Promise<{ name: string; secret: string }> {
  if (!ACCOUNT_RE.test(name)) {
    throw new EnvError('EINVAL', 'account name must be 1-20 letters, digits, _ or -, starting with a letter')
  }
  const secret = secretPath(dataDir, name)
  fs.mkdirSync(path.dirname(secret), { recursive: true })
  await runElevated(['winuser', 'create', '--name', name, '--secret-out', secret])
  for (const p of grantPaths) await runElevated(['winuser', 'grant', '--name', name, '--path', p])
  return { name, secret }
}

/**
 * Delete the account (ending its processes) and, by default, its profile. Resolves with a
 * warning when the account is gone but its profile could not be removed.
 */
export async function deleteWindowsAccount(
  name: string,
  { dataDir, purgeProfile = true }: { dataDir: string; purgeProfile?: boolean },
): Promise<{ warning?: string }> {
  const r = await runElevated(['winuser', 'delete', '--name', name, ...(purgeProfile ? ['--purge-profile'] : [])])
  fs.rmSync(secretPath(dataDir, name), { force: true })
  return typeof r['warning'] === 'string' ? { warning: r['warning'] } : {}
}

export async function grantWindowsAccount(name: string, dir: string): Promise<void> {
  await runElevated(['winuser', 'grant', '--name', name, '--path', dir])
}
