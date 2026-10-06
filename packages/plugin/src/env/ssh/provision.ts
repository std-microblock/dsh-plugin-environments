// Running the bundled dsh-env-server on an SSH host: detect the host, upload the matching
// binary once per content hash, start it for the lifetime of the SSH connection and reach it
// through SSH port forwarding (falling back to stdio over the exec channel).
import crypto from 'node:crypto'
import type { Client as SshClient, ClientChannel, SFTPWrapper, Stats as SftpStats } from 'ssh2'
import { EnvError, errorMessage, generateSecret, secureInitiate, type Transport } from '@dsh-environments/protocol'
import { binaryHash, serverBinaryBytes, targetForHost, type ServerTarget } from '../../server-binary.ts'
import { shq } from '../posix-shell.ts'
import { ServerEnvironment } from '../server/server-env.ts'
import { execOnce } from './connection.ts'

/** Shell that runs exec requests on the remote host. */
export type RemoteShell = 'sh' | 'cmd' | 'powershell'

/** What the plugin learned about an SSH host. */
export interface RemoteHost {
  /** Shipped server target matching the host, if any. */
  target: ServerTarget | undefined
  shell: RemoteShell
  /** Absolute home directory in the host's own spelling. */
  home: string
  /** Path separator for building absolute paths under `home`. */
  sep: '/' | '\\'
}

/** Bundled server binary (decompressed) for a remote `uname -sm`, if one ships with the plugin. */
export function bundledBinaryFor(uname: string): Buffer | undefined {
  const [sys = '', machine = ''] = uname.trim().split(/\s+/)
  const target = targetForHost(sys, machine)
  return target ? serverBinaryBytes(target) : undefined
}

/**
 * Detect the remote OS/arch and shell: `uname -sm` on POSIX hosts (including MSYS/Cygwin
 * sshd on Windows), otherwise Windows OpenSSH via `cmd /c` and a PowerShell probe.
 */
export async function probeHost(conn: SshClient): Promise<RemoteHost | undefined> {
  const posix = await execOnce(conn, 'uname -sm; echo "$HOME"').catch(() => undefined)
  if (posix?.code === 0) {
    const [uname = '', home = ''] = posix.stdout.toString().split(/\r?\n/)
    const [sys = '', machine = ''] = uname.trim().split(/\s+/)
    if (sys && home.trim()) return { target: targetForHost(sys, machine), shell: 'sh', home: home.trim(), sep: '/' }
  }
  const win = await execOnce(conn, 'cmd /c "echo %PROCESSOR_ARCHITECTURE% %USERPROFILE%"').catch(() => undefined)
  const line = win?.code === 0 ? (win.stdout.toString().trim().split(/\r?\n/)[0] ?? '') : ''
  const m = /^(\S+)\s+(.+)$/.exec(line.trim())
  if (!m?.[1] || !m[2] || m[1].startsWith('%')) return undefined
  // In cmd the variable is echoed literally; in Windows PowerShell / pwsh it expands.
  const ps = await execOnce(conn, 'echo $PSVersionTable.PSEdition').catch(() => undefined)
  const shell: RemoteShell = /^(Desktop|Core)\s*$/m.test(ps?.stdout.toString() ?? '') ? 'powershell' : 'cmd'
  return { target: targetForHost('windows', m[1]), shell, home: m[2].trim(), sep: '\\' }
}

/** Quote a command line for the remote shell. */
export function remoteCommand(shell: RemoteShell, program: string, args: readonly string[]): string {
  switch (shell) {
    case 'sh':
      return [program, ...args].map(shq).join(' ')
    case 'powershell': {
      const q = (s: string) => `'${s.replace(/'/g, "''")}'`
      return `& ${[program, ...args].map(q).join(' ')}`
    }
    case 'cmd': {
      const q = (s: string) => (/^[\w.:\\/=-]+$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`)
      return [`"${program}"`, ...args.map(q)].join(' ')
    }
  }
}

function openSftp(conn: SshClient): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => conn.sftp((e, s) => (e ? reject(e) : resolve(s))))
}

const sftpCall = <R>(fn: (cb: (err: Error | null | undefined, r: R) => void) => void): Promise<R> =>
  new Promise((resolve, reject) => fn((err, r) => (err ? reject(err) : resolve(r))))

async function sftpStat(sftp: SFTPWrapper, p: string): Promise<SftpStats | undefined> {
  try {
    return await sftpCall<SftpStats>(cb => sftp.stat(p, cb))
  } catch {
    return undefined
  }
}

/** Create a private (0700) directory, tolerating one that exists. */
async function privateDir(sftp: SFTPWrapper, p: string, posix: boolean): Promise<void> {
  try {
    await sftpCall<undefined>(cb => sftp.mkdir(p, { mode: 0o700 }, err => cb(err, undefined)))
  } catch (e) {
    if (!(await sftpStat(sftp, p))?.isDirectory()) throw e
  }
  if (posix) await sftpCall<undefined>(cb => sftp.chmod(p, 0o700, err => cb(err, undefined))).catch(() => {})
}

/**
 * Upload `data` as `~/.dsh-env/bin/dsh-env-server-<hash>[.exe]` unless an identical file is
 * there: written to a temporary name with mode 0700, then renamed into place. SFTP paths are
 * relative to the login directory (the home directory with OpenSSH on every OS).
 * Returns the absolute remote path.
 */
export async function installBinary(conn: SshClient, host: RemoteHost, data: Buffer): Promise<string> {
  const windows = host.target?.startsWith('win32-') ?? host.sep === '\\'
  const posix = host.sep === '/'
  const name = `dsh-env-server-${binaryHash(data)}${windows ? '.exe' : ''}`
  const rel = `.dsh-env/bin/${name}`
  const abs = [host.home.replace(/[\\/]+$/, ''), '.dsh-env', 'bin', name].join(host.sep)
  const sftp = await openSftp(conn)
  try {
    const existing = await sftpStat(sftp, rel)
    if (existing?.isFile() && existing.size === data.length) return abs
    await privateDir(sftp, '.dsh-env', posix)
    await privateDir(sftp, '.dsh-env/bin', posix)
    const tmp = `${rel}.${crypto.randomBytes(6).toString('hex')}.part`
    await new Promise<void>((resolve, reject) => {
      const w = sftp.createWriteStream(tmp, { mode: 0o700 })
      w.on('close', () => resolve())
      w.on('error', reject)
      w.end(data)
    })
    try {
      if (posix) await sftpCall<undefined>(cb => sftp.chmod(tmp, 0o700, err => cb(err, undefined)))
      try {
        await sftpCall<undefined>(cb => sftp.ext_openssh_rename(tmp, rel, err => cb(err, undefined)))
      } catch {
        await sftpCall<undefined>(cb => sftp.rename(tmp, rel, err => cb(err, undefined)))
      }
    } catch (e) {
      await sftpCall<undefined>(cb => sftp.unlink(tmp, err => cb(err, undefined))).catch(() => {})
      // Another plugin instance may have won the race with an identical file.
      const now = await sftpStat(sftp, rel)
      if (!(now?.isFile() && now.size === data.length))
        throw new EnvError('EIO', `could not install dsh-env-server: ${errorMessage(e)}`)
    }
    return abs
  } finally {
    sftp.end()
  }
}

/** Upload the bundled server matching the host (if one ships) and return its remote path. */
export async function provisionServer(
  conn: SshClient,
  host: RemoteHost,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const data = host.target ? serverBinaryBytes(host.target) : undefined
  if (!data) return undefined
  signal?.throwIfAborted()
  return installBinary(conn, host, data)
}

function exec(conn: SshClient, command: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) =>
    conn.exec(command, (err, stream) => (err ? reject(new EnvError('EIO', err.message)) : resolve(stream))),
  )
}

function forwardOut(conn: SshClient, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) =>
    conn.forwardOut('127.0.0.1', 0, '127.0.0.1', port, (err, ch) => (err ? reject(err) : resolve(ch))),
  )
}

/** Close the exec channel that keeps a lifeline server alive. */
function cutLifeline(stream: ClientChannel): void {
  try {
    stream.end()
  } catch {
    // already closed
  }
  setTimeout(() => {
    try {
      stream.close()
    } catch {
      // already closed
    }
  }, 2000).unref()
}

export interface ServerStartOptions {
  id: string
  name?: string | undefined
  host: RemoteHost
  serverPath: string
  cwd?: string | undefined
  signal?: AbortSignal | undefined
}

/**
 * Start `serve --listen 127.0.0.1:0 --token-stdin --lifeline --exit-idle` over an exec channel,
 * hand it a fresh secret through stdin and connect through a direct-tcpip forward. The server
 * lives exactly as long as the exec channel (lifeline) and its one session (exit-idle).
 * Resolves to undefined when the SSH server refuses port forwarding.
 */
export async function serverOverForward(
  opts: ServerStartOptions & { conn: SshClient },
): Promise<ServerEnvironment | undefined> {
  const { conn, id, name, host, serverPath, cwd, signal } = opts
  const secret = generateSecret()
  const args = [
    'serve',
    '--listen',
    '127.0.0.1:0',
    '--token-stdin',
    '--lifeline',
    '--exit-idle',
    ...(cwd ? ['--cwd', cwd] : []),
  ]
  const stream = await exec(conn, remoteCommand(host.shell, serverPath, args))
  stream.write(`${secret}\n`)
  let stderr = ''
  stream.stderr.on('data', (d: Buffer) => {
    if (stderr.length < 4000) stderr += d.toString()
  })
  const started = await new Promise<{ port: number; pid: number | undefined }>((resolve, reject) => {
    let out = ''
    const done = (e?: Error, v?: { port: number; pid: number | undefined }) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      stream.off('data', onData)
      stream.off('close', onClose)
      if (e) reject(e)
      else if (v) resolve(v)
    }
    const onData = (d: Buffer) => {
      out += d.toString()
      const m = /DSH_ENV_SERVER listening=\S*:(\d+)/.exec(out)
      if (m?.[1]) {
        const pid = /DSH_ENV_SERVER pid=(\d+)/.exec(out)?.[1]
        done(undefined, { port: Number(m[1]), pid: pid ? Number(pid) : undefined })
      }
    }
    const onClose = () =>
      done(new EnvError('EIO', `dsh-env-server exited before listening${stderr ? `: ${stderr.trim()}` : ''}`))
    const onAbort = () => done(new EnvError('CANCELLED', 'aborted'))
    const timer = setTimeout(() => done(new EnvError('ETIMEDOUT', 'dsh-env-server did not start')), 20000)
    signal?.addEventListener('abort', onAbort, { once: true })
    stream.on('data', onData)
    stream.on('close', onClose)
  }).catch((e: unknown) => {
    cutLifeline(stream)
    throw e
  })
  stream.on('data', () => {})
  let channel: ClientChannel
  try {
    channel = await forwardOut(conn, started.port)
  } catch {
    // AllowTcpForwarding no (or similar): let the caller fall back to stdio.
    cutLifeline(stream)
    return undefined
  }
  let transport: Transport
  try {
    transport = await secureInitiate(channel, { secret, signal })
  } catch (e) {
    channel.destroy()
    cutLifeline(stream)
    throw e
  }
  const env = new ServerEnvironment({
    id,
    name,
    kind: 'ssh',
    transport,
    onClose: () => {
      cutLifeline(stream)
      conn.end()
    },
  })
  stream.on('close', () => env.markClosed(new EnvError('CLOSED', 'dsh-env-server exited')))
  env.serverPid = started.pid
  env.transportMode = 'ssh-forward'
  env.remoteEndpoint = `127.0.0.1:${started.port}`
  try {
    return await env.open(signal)
  } catch (e) {
    env.client.close()
    cutLifeline(stream)
    throw e
  }
}

/** Start the server in stdio mode over an exec channel and wrap it (no forwarding needed). */
export async function serverOverExec(
  conn: SshClient,
  command: string,
  { id, name, signal }: { id: string; name?: string | undefined; signal?: AbortSignal | undefined },
): Promise<ServerEnvironment> {
  const stream = await exec(conn, command)
  stream.stderr.on('data', () => {})
  const env = new ServerEnvironment({ id, name, kind: 'ssh', transport: stream, onClose: () => void conn.end() })
  env.transportMode = 'ssh-stdio'
  try {
    return await env.open(signal)
  } catch (e) {
    env.client.close()
    cutLifeline(stream)
    throw e
  }
}
