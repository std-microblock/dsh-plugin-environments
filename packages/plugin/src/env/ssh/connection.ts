// SSH connection setup and one-shot command execution.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ssh2, { type Client as SshClient, type ConnectConfig } from 'ssh2'
import { EnvError, errorMessage } from '@dsh-environments/protocol'
import { expandHome, openProxy, resolveSshTarget, type SshTarget } from './ssh-config.ts'

/** Stored configuration of an SSH environment. */
export interface SshConfig {
  /** A host name, an address, or a `~/.ssh/config` alias. */
  host: string
  port?: number
  username?: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
  readyTimeoutMs?: number
  /**
   * `auto` (default) resolves `host` through the local `~/.ssh/config` with `ssh -G`; `off` connects
   * to `host` literally.
   */
  sshConfig?: 'auto' | 'off'
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

type SshConnectOptions = ConnectConfig & { host: string; port: number; username: string }

const DEFAULT_KEY_FILES = ['id_ed25519', 'id_ecdsa', 'id_rsa'].map(name => path.join(os.homedir(), '.ssh', name))

/**
 * Build ssh2 connect options from an environment config. Values from `target` (the resolved
 * ssh_config) fill in what the environment leaves unset.
 */
export function sshConnectConfig(cfg: SshConfig, target?: SshTarget): SshConnectOptions {
  const out: SshConnectOptions = {
    host: target?.host ?? cfg.host,
    // 0 is what an emptied port field stores: unset, not a port.
    port: cfg.port || target?.port || 22,
    username: cfg.username ?? target?.user ?? os.userInfo().username,
    readyTimeout: cfg.readyTimeoutMs ?? 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
  }
  if (cfg.password) out.password = cfg.password
  if (cfg.privateKeyPath) {
    out.privateKey = fs.readFileSync(expandHome(cfg.privateKeyPath))
    if (cfg.passphrase) out.passphrase = cfg.passphrase
  }
  if (!out.password && !out.privateKey) {
    if (process.platform === 'win32') out.agent = '\\\\.\\pipe\\openssh-ssh-agent'
    else if (process.env['SSH_AUTH_SOCK']) out.agent = process.env['SSH_AUTH_SOCK']
    // Fall back to the configured key files, or the default ones.
    for (const p of target?.identityFiles ?? DEFAULT_KEY_FILES) {
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
export async function connectClient(cfg: SshConfig, signal?: AbortSignal): Promise<SshClient> {
  const target = cfg.sshConfig === 'off' ? undefined : await resolveSshTarget(cfg.host, signal)
  if (signal?.aborted) throw new EnvError('CANCELLED', 'aborted')
  let options: SshConnectOptions
  try {
    options = sshConnectConfig(cfg, target)
  } catch (e) {
    throw new EnvError('EINVAL', `ssh config: ${errorMessage(e)}`)
  }
  const proxy =
    target && openProxy(target, { alias: cfg.host, host: options.host, port: options.port, user: options.username })

  return new Promise((resolve, reject) => {
    const conn = new ssh2.Client()
    const onAbort = () => {
      proxy?.kill()
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
      proxy?.kill()
      const code = e.level === 'client-authentication' ? 'AUTH' : 'EIO'
      void (proxy?.closed ?? Promise.resolve('')).then(reason => {
        reject(new EnvError(code, `ssh ${cfg.host}: ${e.message}${reason ? ` (${reason})` : ''}`))
      })
    })
    // The proxy is the transport, so it lives exactly as long as the connection.
    conn.once('close', () => proxy?.kill())
    try {
      conn.connect(proxy ? { ...options, sock: proxy.sock } : options)
    } catch (e) {
      proxy?.kill()
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
