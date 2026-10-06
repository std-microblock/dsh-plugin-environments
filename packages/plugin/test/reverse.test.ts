import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { serverBinary } from '../src/env/server/connect.ts'
import { reverseCommands, sanitizeReverseSettings } from '../src/env/server/reverse.ts'
import { EnvironmentManager } from '../src/manager/manager.ts'
import { needsServer } from './helpers.ts'

function startConnect(url: string, id: string, secret: string, cwd: string): ChildProcessWithoutNullStreams {
  const child = spawn(serverBinary(), ['connect', url, '--id', id, '--token-stdin', '--lifeline', '--cwd', cwd], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdin.write(`${secret}\n`)
  return child
}

async function until(fn: () => boolean, ms = 15000): Promise<void> {
  const deadline = Date.now() + ms
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time')
    await new Promise(r => setTimeout(r, 50))
  }
}

test('settings sanitising and generated commands', () => {
  const s = sanitizeReverseSettings({ tcp: { enabled: true, port: '7000' }, ws: { path: 'x' }, publicHost: ' h ' })
  assert.deepEqual(s, {
    tcp: { enabled: true, host: '0.0.0.0', port: 7000 },
    ws: { enabled: false, host: '0.0.0.0', port: 7463, path: '/x' },
    publicHost: 'h',
  })
  assert.throws(() => sanitizeReverseSettings({ tcp: { port: 70000 } }), { code: 'EINVAL' })
  const c = reverseCommands({
    id: 'box',
    secret: 'S3',
    status: {
      tcp: { enabled: true, listening: true, host: '0.0.0.0', port: 7462 },
      ws: { enabled: true, listening: true, host: '0.0.0.0', port: 7463, path: '/dsh-env' },
      publicHost: 'example.org',
    },
  })
  assert.deepEqual(c.urls, ['ws://example.org:7463/dsh-env', 'tcp://example.org:7462'])
  assert.match(c.posix ?? '', /umask 077 .*'S3'.*connect ws:\/\/example\.org:7463\/dsh-env --id box --token-file/)
  assert.doesNotMatch(c.posix ?? '', /--token /)
  assert.match(c.windows ?? '', /Set-Content .*'S3'.*dsh-env-server\.exe connect/)
})

test('reverse connections over tcp and websocket', needsServer, async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reverse-test-'))
  const manager = new EnvironmentManager({ dataDir: path.join(tmp, 'data'), autoDiscoverAdb: false })
  manager.load()
  const children: ChildProcessWithoutNullStreams[] = []
  t.after(async () => {
    for (const c of children) c.kill()
    await manager.dispose()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  await manager.setReverseSettings(
    sanitizeReverseSettings({
      tcp: { enabled: true, host: '127.0.0.1', port: 0 },
      ws: { enabled: true, host: '127.0.0.1', port: 0, path: '/rev' },
    }),
  )
  const status = manager.reverse.describe()
  assert.ok(status.tcp.listening && status.ws.listening)
  const def = manager.upsert({ id: 'rev1', name: 'rev1', kind: 'reverse', config: {} })
  const secret = def.config.token ?? ''
  assert.ok(secret.length >= 40, 'a high-entropy secret is generated')
  assert.equal(manager.publicDef(def).config.token, '••••••')

  for (const url of [`tcp://127.0.0.1:${status.tcp.port}`, `ws://127.0.0.1:${status.ws.port}/rev`]) {
    await t.test(url.split(':')[0] ?? url, async () => {
      const child = startConnect(url, 'rev1', secret, tmp)
      children.push(child)
      await until(() => manager.reverse.connected('rev1'))
      // Two environments at once: the server dials a new spare after each one is taken.
      const [a, b] = await Promise.all([manager.open(def), manager.open(def)])
      assert.equal(a.kind, 'reverse')
      await a.writeFile(path.join(tmp, 'r.txt'), 'reverse!')
      assert.equal((await b.readFile(path.join(tmp, 'r.txt'))).toString(), 'reverse!')
      const r = await b.exec({ command: 'echo via-reverse' })
      assert.match(r.stdout.toString(), /via-reverse/)
      assert.equal(manager.reverse.state('rev1').active, 2)
      await a.close()
      await b.close()
      await until(() => manager.reverse.state('rev1').active === 0 && manager.reverse.state('rev1').idle === 1)
      // Lifeline: closing stdin stops the connector.
      const exited = new Promise(r => child.once('exit', r))
      child.stdin.end()
      await exited
      await until(() => !manager.reverse.connected('rev1'))
    })
  }

  await t.test('wrong secret and unknown id are refused', async () => {
    const stderr: string[] = []
    const wrong = startConnect(`tcp://127.0.0.1:${status.tcp.port}`, 'rev1', 'not-the-secret', tmp)
    const unknown = startConnect(`tcp://127.0.0.1:${status.tcp.port}`, 'nobody', secret, tmp)
    children.push(wrong, unknown)
    wrong.stderr.on('data', (d: Buffer) => stderr.push(d.toString()))
    await until(() => stderr.join('').includes('cannot connect'))
    assert.equal(manager.reverse.connected('rev1'), false)
    assert.equal(manager.reverse.connected('nobody'), false)
    await assert.rejects(manager.reverse.take('rev1', { timeoutMs: 300 }), { code: 'ETIMEDOUT' })
  })

  await t.test('rotating the secret drops the connection', async () => {
    const child = startConnect(`ws://127.0.0.1:${status.ws.port}/rev`, 'rev1', secret, tmp)
    children.push(child)
    await until(() => manager.reverse.connected('rev1'))
    const env = await manager.open(def)
    const closed = new Promise(r => env.once('close', r))
    manager.rotateReverseSecret('rev1')
    await closed
    await until(() => !manager.reverse.connected('rev1'))
    child.kill()
  })
})
