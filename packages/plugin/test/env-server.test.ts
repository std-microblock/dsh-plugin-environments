import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openLocal, openServer, startServeProcess } from '../src/env/server/connect.ts'
import { needsServer } from './helpers.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-env-test-'))
const isWin = process.platform === 'win32'

const port = (s: net.Server | dgram.Socket) => (s.address() as net.AddressInfo).port

test('env-server over stdio and tcp', needsServer, async t => {
  const env = await openLocal({ id: 'local', cwd: tmp })
  t.after(() => env.close())

  await t.test('hello info', () => {
    assert.equal(env.info?.family, isWin ? 'windows' : 'posix')
    assert.ok(env.caps.has('fs'))
  })

  await t.test('fs basics', async () => {
    const f = path.join(tmp, 'a', 'b.txt')
    await env.writeFile(f, 'hello\nworld\n', { mkdirs: true })
    assert.equal((await env.readFile(f)).toString(), 'hello\nworld\n')
    const st = await env.stat(f)
    assert.equal(st?.type, 'file')
    assert.equal(st.size, 12)
    assert.equal(await env.stat(path.join(tmp, 'nope')), null)
    const part = await env.readFile(f, { offset: 6, length: 5 })
    assert.equal(part.toString(), 'world')
    await env.writeFile(f, 'more\n', { mode: 'append' })
    assert.match((await env.readFile(f)).toString(), /more/)
    await assert.rejects(env.writeFile(f, 'x', { mode: 'create' }), { code: 'EEXIST' })
    const entries = await env.readdir(path.join(tmp, 'a'))
    assert.deepEqual(
      entries.map(e => e.name),
      ['b.txt'],
    )
    await env.rename(f, path.join(tmp, 'a', 'c.txt'))
    await env.mkdir(path.join(tmp, 'd', 'e'), { recursive: true })
    await env.copy(path.join(tmp, 'a'), path.join(tmp, 'd', 'a2'), { recursive: true })
    assert.ok(await env.stat(path.join(tmp, 'd', 'a2', 'c.txt')))
    await env.remove(path.join(tmp, 'd'), { recursive: true })
    assert.equal(await env.stat(path.join(tmp, 'd')), null)
    await assert.rejects(env.readFile(path.join(tmp, 'missing')), { code: 'ENOENT' })
    const real = await env.realpath(tmp)
    assert.ok(real.length > 0)
  })

  await t.test('glob and grep', async () => {
    await env.writeFile(path.join(tmp, 'src', 'x.ts'), 'export const needle = 1\n', { mkdirs: true })
    await env.writeFile(path.join(tmp, 'src', 'deep', 'y.ts'), 'const Needle = 2\n', { mkdirs: true })
    await env.writeFile(path.join(tmp, 'src', 'z.js'), 'needle\n', { mkdirs: true })
    const g = await env.glob('**/*.ts', { cwd: tmp })
    assert.deepEqual([...g.paths].sort(), ['src/deep/y.ts', 'src/x.ts'])
    const g2 = await env.glob('*.js', { cwd: tmp })
    assert.deepEqual(g2.paths, ['src/z.js'])
    const r = await env.grep('needle', { cwd: tmp, ignoreCase: true, glob: '*.ts' })
    assert.equal(r.matches.length, 2)
    assert.ok(r.matches.every(m => m.line === 1))
    const r2 = await env.grep('needle', { cwd: tmp, filesOnly: true })
    assert.equal(r2.files.length, 2)
  })

  await t.test('large streams', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 123)
    for (let i = 0; i < big.length; i++) big[i] = i % 251
    const f = path.join(tmp, 'big.bin')
    const w = await env.openWrite(f)
    const st = await w.writeAll(big)
    assert.equal(st.size, big.length)
    const chunks: Buffer[] = []
    for await (const c of await env.openRead(f)) chunks.push(c as Buffer)
    assert.ok(Buffer.concat(chunks).equals(big))
    const viaRead = await env.readFile(f, { maxBytes: 64 * 1024 * 1024 })
    assert.ok(viaRead.equals(big))
  })

  await t.test('spawn with stdin', async () => {
    const spec = isWin ? { argv: ['cmd.exe', '/d', '/c', 'findstr x*'] } : { argv: ['cat'] }
    const r = await env.exec(spec, { stdin: 'line one\nline two\n' })
    assert.equal(r.code, 0)
    assert.match(r.stdout.toString(), /line two/)
    const r2 = await env.exec({ command: 'exit 3' })
    assert.equal(r2.code, 3)
    const r3 = await env.exec({ command: 'echo hi', cwd: tmp })
    assert.match(r3.stdout.toString(), /hi/)
  })

  await t.test('kill process tree', async () => {
    const p = await env.spawn(isWin ? { argv: ['ping', '-n', '30', '127.0.0.1'] } : { argv: ['sleep', '30'] })
    setTimeout(() => void p.kill(), 300)
    const exit = await p.exited
    assert.notEqual(exit.code, 0)
  })

  await t.test('pty', async () => {
    const p = await env.spawn({ command: 'echo ptyhello', pty: { rows: 24, cols: 80 } })
    let out = ''
    p.stdout.on('data', (d: Buffer) => {
      out += d.toString()
    })
    await p.exited
    await new Promise(r => setTimeout(r, 300))
    assert.match(out, /ptyhello/)
  })

  await t.test('tcp tunnels', async () => {
    const echo = net.createServer(s => s.pipe(s))
    await new Promise<void>(r => echo.listen(0, '127.0.0.1', r))
    const fwd = await env.forward({ remotePort: port(echo) })
    const reply = await new Promise<string>((resolve, reject) => {
      const c = net.connect(fwd.localPort, '127.0.0.1', () => c.write('ping-tcp'))
      c.on('data', d => {
        resolve(d.toString())
        c.end()
      })
      c.on('error', reject)
    })
    assert.equal(reply, 'ping-tcp')
    await fwd.close()

    const rev = await env.reverse({ remotePort: 0, localPort: port(echo) })
    assert.ok(rev.remotePort > 0)
    const reply2 = await new Promise<string>((resolve, reject) => {
      const c = net.connect(rev.remotePort, '127.0.0.1', () => c.write('ping-rev'))
      c.on('data', d => {
        resolve(d.toString())
        c.end()
      })
      c.on('error', reject)
    })
    assert.equal(reply2, 'ping-rev')
    await rev.close()
    echo.close()
  })

  await t.test('udp tunnels', async () => {
    const echo = dgram.createSocket('udp4')
    echo.on('message', (m, r) => echo.send(m, r.port, r.address))
    await new Promise<void>(r => echo.bind(0, '127.0.0.1', r))
    const fwd = await env.forward({ remotePort: port(echo), proto: 'udp' })
    const client = dgram.createSocket('udp4')
    const reply = await new Promise<string>(resolve => {
      client.on('message', m => resolve(m.toString()))
      client.send('ping-udp', fwd.localPort, '127.0.0.1')
    })
    assert.equal(reply, 'ping-udp')
    client.close()
    await fwd.close()

    const rev = await env.reverse({ remotePort: 0, localPort: port(echo), proto: 'udp' })
    const c2 = dgram.createSocket('udp4')
    const reply2 = await new Promise<string>(resolve => {
      c2.on('message', m => resolve(m.toString()))
      c2.send('ping-udp-rev', rev.remotePort, '127.0.0.1')
    })
    assert.equal(reply2, 'ping-udp-rev')
    c2.close()
    await rev.close()
    echo.close()
  })

  await t.test('tcp serve with token', async () => {
    const { port: servePort, token, child } = await startServeProcess({ cwd: tmp })
    try {
      await assert.rejects(openServer({ id: 'x', host: '127.0.0.1', port: servePort, token: 'wrong' }), {
        code: 'AUTH',
      })
      const remote = await openServer({ id: 'x', host: '127.0.0.1', port: servePort, token })
      const st = await remote.stat(tmp)
      assert.equal(st?.type, 'dir')
      await remote.close()
    } finally {
      child.kill()
    }
  })
})

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
