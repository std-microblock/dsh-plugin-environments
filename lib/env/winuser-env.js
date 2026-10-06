// Windows environments that run as a dsh-managed local account on the interactive desktop.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { EnvError } from '../protocol/client.js'
import { openServer, serverBinary } from './connect.js'
import { runHost } from './adb-env.js'

export const ACCOUNT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/

function secretPath(dataDir, name) {
  return path.resolve(dataDir, 'winusers', `${name}.secret`)
}

/** Copy the server binary to a location every local account can execute. */
export function sharedBinary(binary) {
  const src = serverBinary(binary)
  const base = process.env.ProgramData ?? 'C:\\ProgramData'
  const dir = path.join(base, 'dsh-env')
  const dst = path.join(dir, 'dsh-env-server.exe')
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

/** Locate gsudo (used instead of a UAC prompt when the user has it installed). */
function findGsudo() {
  const dirs = (process.env.PATH ?? '').split(path.delimiter)
  if (process.env.USERPROFILE) dirs.push(path.join(process.env.USERPROFILE, 'scoop', 'apps', 'gsudo', 'current'))
  for (const d of dirs) {
    const p = path.join(d.replace(/^"|"$/g, ''), 'gsudo.exe')
    if (d && fs.existsSync(p)) return p
  }
  return undefined
}

/**
 * Run a dsh-env-server winuser command elevated. The command and its output redirection live in a
 * temporary .cmd script, so no quoting passes through cmd /c. gsudo is used when present;
 * otherwise Windows shows a UAC prompt on the host desktop.
 */
async function runElevated(args, { timeoutMs = 180000 } = {}) {
  if (process.platform !== 'win32') throw new EnvError('UNSUPPORTED', 'Windows accounts can only be managed on Windows hosts')
  const bin = serverBinary()
  const id = crypto.randomUUID()
  const out = path.join(os.tmpdir(), `dsh-env-elev-${id}.json`)
  const script = path.join(os.tmpdir(), `dsh-env-elev-${id}.cmd`)
  const quote = a => `"${String(a).replace(/"/g, '""')}"`
  fs.writeFileSync(script, `@echo off\r\nchcp 65001 >nul\r\n${quote(bin)} ${args.map(quote).join(' ')} > ${quote(out)} 2>&1\r\n`)
  let r
  try {
    const gsudo = findGsudo()
    if (gsudo) {
      r = await runHost(gsudo, ['cmd.exe', '/d', '/c', script], { timeoutMs })
    } else {
      const ps = `$p = Start-Process -FilePath '${script.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`
      r = await runHost('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs })
    }
  } finally {
    fs.rmSync(script, { force: true })
  }
  let text = ''
  try { text = fs.readFileSync(out, 'utf8') } catch {}
  fs.rmSync(out, { force: true })
  if (!text.trim()) throw new EnvError('EACCES', `administrator approval was cancelled or failed${r.stderr.trim() ? `: ${r.stderr.trim()}` : ''}`)
  let parsed
  try { parsed = JSON.parse(text.trim().split(/\r?\n/).pop()) } catch { throw new EnvError('EIO', `unexpected output: ${text.trim()}`) }
  if (!parsed.ok) throw new EnvError('EIO', parsed.error ?? 'operation failed')
  return parsed
}

export async function listWindowsAccounts() {
  if (process.platform !== 'win32') return []
  const r = await runHost(serverBinary(), ['winuser', 'list'], { timeoutMs: 20000 })
  try { return JSON.parse(r.stdout.toString()) } catch { return [] }
}

export async function createWindowsAccount(name, { dataDir, grantPaths = [] }) {
  if (!ACCOUNT_RE.test(name)) throw new EnvError('EINVAL', 'account name must be 1-20 letters, digits, _ or -, starting with a letter')
  const secret = secretPath(dataDir, name)
  fs.mkdirSync(path.dirname(secret), { recursive: true })
  await runElevated(['winuser', 'create', '--name', name, '--secret-out', secret])
  for (const p of grantPaths) await runElevated(['winuser', 'grant', '--name', name, '--path', p])
  return { name, secret }
}

export async function deleteWindowsAccount(name, { dataDir, purgeProfile = true }) {
  await runElevated(['winuser', 'delete', '--name', name, ...purgeProfile ? ['--purge-profile'] : []])
  fs.rmSync(secretPath(dataDir, name), { force: true })
}

export async function grantWindowsAccount(name, dir) {
  await runElevated(['winuser', 'grant', '--name', name, '--path', dir])
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
    s.on('error', reject)
  })
}

/** Start dsh-env-server as the account on the interactive desktop and connect to it. */
export async function openWindowsAccount({ id, name, account, dataDir, cwd, signal }) {
  const secret = secretPath(dataDir, account)
  if (!fs.existsSync(secret)) throw new EnvError('ENOENT', `no stored credentials for account ${account}; recreate it from the Environments page`)
  const bin = sharedBinary()
  const port = await freePort()
  const token = crypto.randomBytes(24).toString('hex')
  const args = ['winuser', 'launch', '--name', account, '--secret-file', secret, ...cwd ? ['--cwd', cwd] : [], '--', bin, 'serve', '--listen', `127.0.0.1:${port}`, '--token', token, '--once', ...cwd ? ['--cwd', cwd] : []]
  const r = await runHost(serverBinary(), args, { timeoutMs: 30000 })
  let launched
  try { launched = JSON.parse(r.stdout.toString().trim().split(/\r?\n/).pop()) } catch {}
  if (!launched?.ok) throw new EnvError('EIO', `could not start a session as ${account}: ${launched?.error ?? (r.stderr || r.stdout.toString())}`)
  const deadline = Date.now() + 30000
  let lastError
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new EnvError('CANCELLED', 'aborted')
    try {
      const env = await openServer({ id, name, kind: 'winuser', host: '127.0.0.1', port, token, signal, timeoutMs: 3000 })
      env.account = account
      env.serverPid = launched.pid
      return env
    } catch (e) {
      lastError = e
      if (e.code === 'AUTH') throw e
      await new Promise(r => setTimeout(r, 400))
    }
  }
  throw new EnvError('ETIMEDOUT', `the server started as ${account} did not accept connections: ${lastError?.message ?? ''}`)
}
