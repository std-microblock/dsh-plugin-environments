import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import ssh2 from 'ssh2'
import { openSsh } from '../src/env/ssh/open.ts'
import { remoteCommand } from '../src/env/ssh/provision.ts'
import { ServerEnvironment } from '../src/env/server/server-env.ts'
import { openServer, serverBinary } from '../src/env/server/connect.ts'
import { needsServer } from './helpers.ts'

const { Server, utils } = ssh2
const { STATUS_CODE, OPEN_MODE } = utils.sftp
const isWin = process.platform === 'win32'

interface FakeSshdOptions {
  /** Home directory of the fake user (HOME / USERPROFILE of exec children, SFTP login dir). */
  home: string
  /** Refuse direct-tcpip like `AllowTcpForwarding no`. */
  allowForward?: boolean
}

function attrsOf(st: fs.Stats) {
  return {
    mode: st.mode | (st.isDirectory() ? 0o040000 : st.isFile() ? 0o100000 : 0),
    uid: 0,
    gid: 0,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  }
}

/**
 * Minimal SSH server: password auth; exec through the host's shell like OpenSSH (sh -c, or
 * cmd.exe /c on Windows, mirroring Windows OpenSSH); a small SFTP subsystem rooted at `home`;
 * direct-tcpip forwarding. Closing a channel only closes the child's stdin, like sshd.
 */
function startFakeSshd({ home, allowForward = true }: FakeSshdOptions): Promise<ssh2.Server> {
  const hostKey = utils.generateKeyPairSync('ed25519').private
  const resolve = (p: string) => (path.isAbsolute(p) ? p : path.join(home, p))
  const server = new Server({ hostKeys: [hostKey] }, client => {
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'secret') ctx.accept()
      else ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept()
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()
          const env = { ...process.env, HOME: home, USERPROFILE: home }
          const child = isWin
            ? spawn('cmd.exe', ['/d', '/s', '/c', `"${info.command}"`], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                windowsVerbatimArguments: true,
                cwd: home,
                env,
              })
            : spawn('sh', ['-c', info.command], { stdio: ['pipe', 'pipe', 'pipe'], cwd: home, env })
          // Keep the channel open until the exit status is sent.
          child.stdout.pipe(stream, { end: false })
          child.stderr.pipe(stream.stderr, { end: false })
          stream.on('data', (d: Buffer) => child.stdin.write(d))
          stream.on('end', () => child.stdin.end())
          child.stdin.on('error', () => {})
          child.on('close', code => {
            try {
              stream.exit(code ?? 1)
              stream.end()
            } catch {
              // channel already gone
            }
          })
          // Like sshd: a closed channel closes the pipes, it does not kill the process.
          stream.on('close', () => child.stdin.end())
        })
        session.on('sftp', acceptSftp => {
          const sftp = acceptSftp()
          const handles = new Map<number, number>()
          let next = 1
          const fdOf = (h: Buffer) => handles.get(h.readUInt32BE(0))
          const fail = (reqid: number, e: unknown) =>
            sftp.status(
              reqid,
              (e as NodeJS.ErrnoException).code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE,
              String(e),
            )
          sftp.on('OPEN', (reqid, filename, flags) => {
            try {
              const mode = flags & OPEN_MODE.WRITE ? (flags & OPEN_MODE.EXCL ? 'wx' : 'w') : 'r'
              const fd = fs.openSync(resolve(filename), mode)
              const h = Buffer.alloc(4)
              h.writeUInt32BE(next)
              handles.set(next++, fd)
              sftp.handle(reqid, h)
            } catch (e) {
              fail(reqid, e)
            }
          })
          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const fd = fdOf(handle)
            if (fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
            fs.writeSync(fd, data, 0, data.length, offset)
            sftp.status(reqid, STATUS_CODE.OK)
          })
          sftp.on('FSETSTAT', reqid => sftp.status(reqid, STATUS_CODE.OK))
          sftp.on('FSTAT', (reqid, handle) => {
            const fd = fdOf(handle)
            if (fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
            sftp.attrs(reqid, attrsOf(fs.fstatSync(fd)))
          })
          sftp.on('CLOSE', (reqid, handle) => {
            const fd = fdOf(handle)
            if (fd !== undefined) fs.closeSync(fd)
            handles.delete(handle.readUInt32BE(0))
            sftp.status(reqid, STATUS_CODE.OK)
          })
          const stat = (reqid: number, p: string) => {
            try {
              sftp.attrs(reqid, attrsOf(fs.statSync(resolve(p))))
            } catch (e) {
              fail(reqid, e)
            }
          }
          sftp.on('STAT', stat)
          sftp.on('LSTAT', stat)
          sftp.on('SETSTAT', (reqid, p, attrs) => {
            try {
              if (attrs.mode !== undefined) fs.chmodSync(resolve(p), attrs.mode & 0o7777)
              sftp.status(reqid, STATUS_CODE.OK)
            } catch (e) {
              fail(reqid, e)
            }
          })
          sftp.on('MKDIR', (reqid, p) => {
            try {
              fs.mkdirSync(resolve(p), { mode: 0o700 })
              sftp.status(reqid, STATUS_CODE.OK)
            } catch (e) {
              fail(reqid, e)
            }
          })
          sftp.on('RENAME', (reqid, from, to) => {
            try {
              if (fs.existsSync(resolve(to))) throw new Error('target exists')
              fs.renameSync(resolve(from), resolve(to))
              sftp.status(reqid, STATUS_CODE.OK)
            } catch (e) {
              fail(reqid, e)
            }
          })
          sftp.on('REMOVE', (reqid, p) => {
            try {
              fs.rmSync(resolve(p))
              sftp.status(reqid, STATUS_CODE.OK)
            } catch (e) {
              fail(reqid, e)
            }
          })
        })
      })
      client.on('tcpip', (accept, reject, info) => {
        if (!allowForward) {
          reject()
          return
        }
        const socket = net.connect(info.destPort, info.destIP, () => {
          const stream = accept()
          socket.pipe(stream).pipe(socket)
        })
        socket.on('error', () => {})
      })
    })
    client.on('error', () => {})
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)))
}

/** TCP proxy in front of the sshd so a test can cut the network abruptly. */
function startProxy(port: number): Promise<{ port: number; cut: () => void; close: () => void }> {
  const sockets = new Set<net.Socket>()
  const proxy = net.createServer(a => {
    const b = net.connect(port, '127.0.0.1')
    sockets.add(a).add(b)
    a.pipe(b).pipe(a)
    a.on('error', () => {})
    b.on('error', () => {})
  })
  return new Promise(r =>
    proxy.listen(0, '127.0.0.1', () =>
      r({
        port: (proxy.address() as net.AddressInfo).port,
        cut: () => sockets.forEach(s => s.destroy()),
        close: () => proxy.close(),
      }),
    ),
  )
}

const portOf = (s: ssh2.Server) => (s.address() as net.AddressInfo).port

async function waitGone(pid: number | undefined, ms = 15000): Promise<void> {
  assert.ok(pid, 'pid is known')
  const deadline = Date.now() + ms
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    if (Date.now() > deadline) assert.fail(`process ${pid} is still running`)
    await new Promise(r => setTimeout(r, 100))
  }
}

/** Remove a fake home; Windows keeps a directory busy for a moment after its last process exits. */
async function removeHome(home: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(home, { recursive: true, force: true })
      return
    } catch (e) {
      if (i > 50) throw e
      await new Promise(r => setTimeout(r, 200))
    }
  }
}

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-home-'))
}

const sleepSpec = isWin ? { argv: ['ping', '-n', '120', '127.0.0.1'] } : { argv: ['sleep', '120'] }

test('remote command quoting per shell', () => {
  assert.equal(remoteCommand('sh', '/a b/x', ['serve', "it's"]), `'/a b/x' 'serve' 'it'\\''s'`)
  assert.equal(
    remoteCommand('cmd', 'C:\\A B\\x.exe', ['serve', '--listen', '127.0.0.1:0', 'a b']),
    `"C:\\A B\\x.exe" serve --listen 127.0.0.1:0 "a b"`,
  )
  assert.equal(remoteCommand('powershell', "C:\\x's.exe", ['serve']), `& 'C:\\x''s.exe' 'serve'`)
})

test('ssh: bundled server is uploaded once and reached through port forwarding', needsServer, async t => {
  const home = tmpHome()
  const sshd = await startFakeSshd({ home })
  t.after(async () => {
    sshd.close()
    await removeHome(home)
  })
  const config = { host: '127.0.0.1', port: portOf(sshd), username: 'tester', password: 'secret', cwd: home }
  const env = await openSsh({ id: 'fake', name: 'fake', config })
  assert.ok(env instanceof ServerEnvironment && env.viaServer)
  assert.equal(env.transportMode, 'ssh-forward')
  const installed = fs.readdirSync(path.join(home, '.dsh-env', 'bin'))
  assert.equal(installed.length, 1)
  assert.match(installed[0] ?? '', /^dsh-env-server-[0-9a-f]{16}(\.exe)?$/)
  const file = path.join(home, '.dsh-env', 'bin', installed[0] ?? '')
  assert.equal(fs.statSync(file).size, fs.statSync(serverBinary()).size)
  if (!isWin) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(home, '.dsh-env')).mode & 0o777, 0o700)
  }
  const mtime = fs.statSync(file).mtimeMs

  await env.writeFile(path.join(home, 'x.txt'), 'over ssh')
  assert.equal((await env.readFile(path.join(home, 'x.txt'))).toString(), 'over ssh')
  const r = await env.exec({ command: 'echo via-ssh' })
  assert.match(r.stdout.toString(), /via-ssh/)

  // Other local users can reach the loopback port but not the server without the secret.
  const [, port] = (env.remoteEndpoint ?? '').split(':')
  await assert.rejects(openServer({ id: 'intruder', host: '127.0.0.1', port: Number(port), token: 'guess' }), {
    code: 'AUTH',
  })

  // Lifeline: closing the environment stops the server and its process trees.
  const sleeper = await env.spawn(sleepSpec)
  sleeper.stdout.on('error', () => {})
  sleeper.stderr.on('error', () => {})
  const serverPid = env.serverPid
  await env.close()
  await waitGone(serverPid)
  await waitGone(sleeper.pid)

  // A second connection reuses the uploaded binary.
  const again = await openSsh({ id: 'fake', name: 'fake', config })
  assert.equal(fs.statSync(file).mtimeMs, mtime)
  assert.deepEqual(fs.readdirSync(path.join(home, '.dsh-env', 'bin')), installed)
  await again.close()
})

test('ssh: a dropped network connection takes the server down', needsServer, async t => {
  const home = tmpHome()
  const sshd = await startFakeSshd({ home })
  const proxy = await startProxy(portOf(sshd))
  t.after(async () => {
    proxy.close()
    sshd.close()
    await removeHome(home)
  })
  const env = await openSsh({
    id: 'drop',
    config: { host: '127.0.0.1', port: proxy.port, username: 'tester', password: 'secret', cwd: home },
  })
  assert.ok(env instanceof ServerEnvironment)
  const sleeper = await env.spawn(sleepSpec)
  sleeper.stdout.on('error', () => {})
  sleeper.stderr.on('error', () => {})
  const closed = new Promise(r => env.once('close', r))
  proxy.cut()
  await closed
  await waitGone(env.serverPid)
  await waitGone(sleeper.pid)
})

test('ssh: falls back to stdio over exec when forwarding is refused', needsServer, async t => {
  const home = tmpHome()
  const sshd = await startFakeSshd({ home, allowForward: false })
  t.after(async () => {
    sshd.close()
    await removeHome(home)
  })
  const env = await openSsh({
    id: 'noforward',
    config: { host: '127.0.0.1', port: portOf(sshd), username: 'tester', password: 'secret', cwd: home },
  })
  try {
    assert.ok(env instanceof ServerEnvironment)
    assert.equal(env.transportMode, 'ssh-stdio')
    const r = await env.exec({ command: 'echo stdio-mode' })
    assert.match(r.stdout.toString(), /stdio-mode/)
  } finally {
    await env.close()
  }
})

test('ssh: explicit serverPath and transport stdio', needsServer, async t => {
  const home = tmpHome()
  const sshd = await startFakeSshd({ home })
  t.after(async () => {
    sshd.close()
    await removeHome(home)
  })
  const env = await openSsh({
    id: 'fixed',
    config: {
      host: '127.0.0.1',
      port: portOf(sshd),
      username: 'tester',
      password: 'secret',
      serverPath: serverBinary(),
      transport: 'stdio',
      cwd: home,
    },
  })
  try {
    assert.ok(env instanceof ServerEnvironment)
    assert.equal(env.transportMode, 'ssh-stdio')
    assert.ok(!fs.existsSync(path.join(home, '.dsh-env')), 'nothing is uploaded with serverPath')
    const g = await env.glob('*', { cwd: home })
    assert.deepEqual(g.paths, [])
  } finally {
    await env.close()
  }
})

test('ssh authentication failure is reported', async () => {
  const home = tmpHome()
  const sshd = await startFakeSshd({ home })
  try {
    await assert.rejects(
      openSsh({
        id: 'x',
        name: 'x',
        config: { host: '127.0.0.1', port: portOf(sshd), username: 'tester', password: 'wrong', install: 'off' },
      }),
      { code: 'AUTH' },
    )
  } finally {
    sshd.close()
    await removeHome(home)
  }
})
