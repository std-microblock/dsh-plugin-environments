import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'
import { openSsh } from '../lib/env/ssh-env.js'
import { serverBinary } from '../lib/env/connect.js'

const { Server, utils } = ssh2

/** Minimal SSH server: password auth, exec through sh, direct-tcpip forwarding. */
function startFakeSshd() {
  const hostKey = utils.generateKeyPairSync('ed25519').private
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
          const child = spawn('sh', ['-c', info.command], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
          child.stdout.pipe(stream)
          child.stderr.pipe(stream.stderr)
          stream.pipe(child.stdin)
          child.on('close', code => { stream.exit(code ?? 1); stream.end() })
          stream.on('close', () => { try { child.kill() } catch {} })
        })
      })
      client.on('tcpip', (accept, _reject, info) => {
        const socket = net.connect(info.destPort, info.destIP, () => {
          const stream = accept()
          socket.pipe(stream).pipe(socket)
        })
        socket.on('error', () => {})
      })
    })
    client.on('error', () => {})
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

test('ssh environment runs dsh-env-server over an exec channel', async () => {
  const sshd = await startFakeSshd()
  const port = sshd.address().port
  const bin = serverBinary().replace(/\\/g, '/')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-test-'))
  const env = await openSsh({
    id: 'fake', name: 'fake',
    config: { host: '127.0.0.1', port, username: 'tester', password: 'secret', serverPath: bin, cwd: tmp },
  })
  try {
    assert.equal(env.kind, 'ssh')
    assert.ok(env.viaServer)
    await env.writeFile(path.join(tmp, 'x.txt'), 'over ssh')
    assert.equal((await env.readFile(path.join(tmp, 'x.txt'))).toString(), 'over ssh')
    const r = await env.exec({ command: 'echo via-ssh' })
    assert.match(r.stdout.toString(), /via-ssh/)
    const g = await env.glob('*.txt', { cwd: tmp })
    assert.deepEqual(g.paths, ['x.txt'])
  } finally {
    await env.close()
    sshd.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('ssh authentication failure is reported', async () => {
  const sshd = await startFakeSshd()
  try {
    await assert.rejects(
      openSsh({ id: 'x', name: 'x', config: { host: '127.0.0.1', port: sshd.address().port, username: 'tester', password: 'wrong', install: 'off' } }),
      { code: 'AUTH' },
    )
  } finally {
    sshd.close()
  }
})
