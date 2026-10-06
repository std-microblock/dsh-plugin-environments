// Opening SSH environments: dsh-env-server over an exec channel when possible, else plain SFTP/exec.
import { EnvError } from '@dsh-environments/protocol'
import type { Environment } from '../environment.ts'
import { shq } from '../posix-shell.ts'
import { connectClient, type SshConfig } from './connection.ts'
import { provisionServer, serverOverExec } from './provision.ts'
import { SshEnvironment } from './ssh-env.ts'

export interface OpenSshOptions {
  id: string
  name?: string | undefined
  config: SshConfig
  signal?: AbortSignal | undefined
}

/**
 * Open an SSH-backed environment. When a dsh-env-server binary is available on the remote host
 * (configured `serverPath`, or the bundled Linux build uploaded on demand) it runs over an exec
 * channel and a full-featured ServerEnvironment is returned; otherwise an SshEnvironment.
 */
export async function openSsh({ id, name, config, signal }: OpenSshOptions): Promise<Environment> {
  const conn = await connectClient(config, signal)
  let serverPath = config.serverPath
  if (!serverPath && config.install !== 'off') {
    serverPath = await provisionServer(conn, signal).catch(() => undefined)
  }
  if (serverPath) {
    try {
      const env = await serverOverExec(
        conn,
        `${shq(serverPath)} stdio${config.cwd ? ` --cwd ${shq(config.cwd)}` : ''}`,
        { id, name },
      )
      conn.on('close', () => env.markClosed(new EnvError('CLOSED', 'ssh connection closed')))
      await env.open(signal)
      env.ssh = conn
      env.viaServer = true
      return env
    } catch (e) {
      if (config.serverPath) {
        conn.end()
        throw e
      }
      // Fall back to plain SFTP/exec below.
    }
  }
  const env = new SshEnvironment({ id, name, conn, config })
  await env.open()
  return env
}
