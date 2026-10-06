// Running the bundled dsh-env-server on an SSH host.
import crypto from 'node:crypto'
import type { Client as SshClient, SFTPWrapper } from 'ssh2'
import { CallbackTransport, EnvError } from '@dsh-environments/protocol'
import { serverBinaryBytes, targetForHost } from '../../server-binary.ts'
import { shq } from '../posix-shell.ts'
import { ServerEnvironment } from '../server/server-env.ts'
import { execOnce } from './connection.ts'

/** Bundled server binary (decompressed) for a remote `uname -sm`, if one ships with the plugin. */
export function bundledBinaryFor(uname: string): Buffer | undefined {
  const [sys = '', machine = ''] = uname.trim().split(/\s+/)
  const target = targetForHost(sys, machine)
  return target ? serverBinaryBytes(target) : undefined
}

function openSftp(conn: SshClient): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => conn.sftp((e, s) => (e ? reject(e) : resolve(s))))
}

/** Upload the bundled server (once per version) and return its remote path. */
export async function provisionServer(conn: SshClient, signal?: AbortSignal): Promise<string | undefined> {
  const probe = await execOnce(conn, 'uname -sm; echo "$HOME"')
  if (probe.code !== 0) return undefined
  const [uname, home] = probe.stdout.toString().split(/\r?\n/)
  const data = bundledBinaryFor(uname ?? '')
  if (!data || !home) return undefined
  const hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 12)
  const dir = `${home}/.dsh-env/bin`
  const remote = `${dir}/dsh-env-server-${hash}`
  const check = await execOnce(conn, `test -x ${shq(remote)} && wc -c < ${shq(remote)}`)
  if (check.code === 0 && Number(check.stdout.toString().trim()) === data.length) return remote
  signal?.throwIfAborted()
  await execOnce(conn, `mkdir -p ${shq(dir)}`)
  const sftp = await openSftp(conn)
  const tmp = `${remote}.part`
  try {
    await new Promise((resolve, reject) => {
      const w = sftp.createWriteStream(tmp, { mode: 0o755 })
      w.on('close', resolve)
      w.on('error', reject)
      w.end(data)
    })
  } finally {
    sftp.end()
  }
  const mv = await execOnce(conn, `chmod 755 ${shq(tmp)} && mv -f ${shq(tmp)} ${shq(remote)}`)
  if (mv.code !== 0) throw new EnvError('EIO', `could not install dsh-env-server: ${mv.stderr}`)
  return remote
}

/** Start `command` (a dsh-env-server in stdio mode) over an exec channel and wrap it. */
export function serverOverExec(
  conn: SshClient,
  command: string,
  { id, name }: { id: string; name?: string | undefined },
): Promise<ServerEnvironment> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) {
        reject(err)
        return
      }
      const transport = new CallbackTransport({
        write: buf => stream.write(buf),
        end: () => stream.end(),
        destroy: () => {
          try {
            stream.close()
          } catch {
            // already closed
          }
        },
      })
      stream.on('data', (d: Buffer) => transport.emit('data', d))
      stream.on('close', () => transport.emit('close'))
      stream.on('error', (e: Error) => transport.emit('error', e))
      stream.stderr.on('data', () => {})
      resolve(new ServerEnvironment({ id, name, kind: 'ssh', transport, onClose: () => void conn.end() }))
    })
  })
}
