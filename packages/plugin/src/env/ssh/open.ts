// Opening SSH environments: dsh-env-server through SSH port forwarding (or stdio over an exec
// channel) when possible, else plain SFTP/exec.
import { EnvError } from '@dsh-environments/protocol'
import type { Environment } from '../environment.ts'
import type { ServerEnvironment } from '../server/server-env.ts'
import { connectClient, type SshConfig } from './connection.ts'
import { probeHost, provisionServer, remoteCommand, serverOverExec, serverOverForward } from './provision.ts'
import { SshEnvironment } from './ssh-env.ts'

export interface OpenSshOptions {
  id: string
  name?: string | undefined
  config: SshConfig
  signal?: AbortSignal | undefined
}

/**
 * Open an SSH-backed environment. When a dsh-env-server binary is available on the remote host
 * (configured `serverPath`, or the bundled build for the detected OS/arch uploaded on demand)
 * it is started for this connection only and a full-featured ServerEnvironment is returned;
 * otherwise an SshEnvironment (SFTP + exec).
 */
export async function openSsh({ id, name, config, signal }: OpenSshOptions): Promise<Environment> {
  const conn = await connectClient(config, signal)
  try {
    const host = await probeHost(conn)
    let serverPath = config.serverPath
    if (!serverPath && config.install !== 'off' && host) {
      // No binary for this host, or the upload failed: use plain SFTP/exec.
      serverPath = await provisionServer(conn, host, signal).catch(() => undefined)
    }
    if (serverPath && host) {
      let env: ServerEnvironment | undefined
      try {
        if (config.transport !== 'stdio') {
          env = await serverOverForward({ conn, id, name, host, serverPath, cwd: config.cwd, signal })
        }
        env ??= await serverOverExec(
          conn,
          remoteCommand(host.shell, serverPath, ['stdio', ...(config.cwd ? ['--cwd', config.cwd] : [])]),
          { id, name, signal },
        )
        const opened = env
        conn.on('close', () => opened.markClosed(new EnvError('CLOSED', 'ssh connection closed')))
        env.ssh = conn
        env.viaServer = true
        return env
      } catch (e) {
        if (config.serverPath) throw e
        // Fall back to plain SFTP/exec below.
      }
    }
    const env = new SshEnvironment({ id, name, conn, config })
    await env.open()
    return env
  } catch (e) {
    conn.end()
    throw e
  }
}
