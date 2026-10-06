// SSH connection setup and one-shot command execution.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ssh2, { type Client as SshClient, type ConnectConfig } from 'ssh2'
import { EnvError, errorMessage } from '@dsh-environments/protocol'

/** Stored configuration of an SSH environment. */
export interface SshConfig {
  host: string
  port?: number
  username?: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
  readyTimeoutMs?: number
  /** Working directory in the remote host. */
  cwd?: string
  /** Existing dsh-env-server on the remote host; skips provisioning. */
  serverPath?: string
  /** `off` disables uploading the bundled server. */
  install?: 'off' | 'auto'
  /**
   * How to reach the server: `auto` = SSH port forwarding to a loopback listener, falling back
   * to stdio over the exec channel when forwarding is refused; `stdio` = always stdio.
   */
  transport?: 'auto' | 'stdio'
}

/** Build ssh2 connect options from an environment config. */
export function sshConnectConfig(cfg: SshConfig): ConnectConfig {
  const out: ConnectConfig = {
    host: cfg.host,
    port: cfg.port ?? 22,
    username: cfg.username ?? os.userInfo().username,
    readyTimeout: cfg.readyTimeoutMs ?? 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
  }
  if (cfg.password) out.password = cfg.password
  if (cfg.privateKeyPath) {
    const p = cfg.privateKeyPath.replace(/^~(?=$|[\\/])/, os.homedir())
    out.privateKey = fs.readFileSync(p)
    if (cfg.passphrase) out.passphrase = cfg.passphrase
  }
  if (!out.password && !out.privateKey) {
    if (process.platform === 'win32') out.agent = '\\\\.\\pipe\\openssh-ssh-agent'
    else if (process.env['SSH_AUTH_SOCK']) out.agent = process.env['SSH_AUTH_SOCK']
    // Fall back to default key files.
    for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
      const p = path.join(os.homedir(), '.ssh', name)
      if (!out.privateKey && fs.existsSync(p)) {
        try {
          out.privateKey = fs.readFileSync(p)
        } catch {
          // unreadable key
        }
      }
    }
  }
  return out
}

/** Connect and authenticate; resolves once the connection is ready. */
export function connectClient(cfg: SshConfig, signal?: AbortSignal): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const conn = new ssh2.Client()
    const onAbort = () => {
      conn.end()
      reject(new EnvError('CANCELLED', 'aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    conn.once('ready', () => {
      signal?.removeEventListener('abort', onAbort)
      resolve(conn)
    })
    conn.once('error', (e: Error & { level?: string }) => {
      signal?.removeEventListener('abort', onAbort)
      reject(new EnvError(e.level === 'client-authentication' ? 'AUTH' : 'EIO', `ssh ${cfg.host}: ${e.message}`))
    })
    try {
      conn.connect(sshConnectConfig(cfg))
    } catch (e) {
      reject(new EnvError('EINVAL', `ssh config: ${errorMessage(e)}`))
    }
  })
}

export interface ExecOnceResult {
  code: number | null
  signal: string | undefined
  stdout: Buffer
  stderr: string
}

/** Run one command over an exec channel and collect its output. */
export function execOnce(
  conn: SshClient,
  command: string,
  { input, maxBytes = 64 * 1024 * 1024 }: { input?: string | Buffer; maxBytes?: number } = {},
): Promise<ExecOnceResult> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) {
        reject(new EnvError('EIO', err.message))
        return
      }
      const out: Buffer[] = []
      const errOut: Buffer[] = []
      let size = 0
      stream.on('data', (d: Buffer) => {
        size += d.length
        if (size <= maxBytes) out.push(d)
      })
      stream.stderr.on('data', (d: Buffer) => errOut.push(d))
      stream.on('close', (code: number | null, signal?: string) =>
        resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(errOut).toString() }),
      )
      if (input !== undefined) stream.end(input)
      else stream.end()
    })
  })
}
