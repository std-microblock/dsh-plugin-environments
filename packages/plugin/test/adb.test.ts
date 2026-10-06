import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AdbEnvironment } from '../src/env/adb/adb-env.ts'
import { listAdbDevices } from '../src/env/adb/devices.ts'
import { filterGlob, globToRegExp, parseGrep, parseReaddir, parseStat } from '../src/env/posix-shell.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const FAKE = [process.execPath, path.join(here, 'fixtures', 'fake-adb.mjs')]
const hasSh = spawnSync('sh', ['-c', 'echo ok']).stdout?.toString().trim() === 'ok'

test('glob conversion', () => {
  assert.ok(globToRegExp('*.kt').test('app/src/Main.kt'))
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b/c.ts'))
  assert.ok(globToRegExp('src/**/*.ts').test('src/c.ts'))
  assert.ok(!globToRegExp('src/*.ts').test('src/a/c.ts'))
  assert.ok(globToRegExp('*.{png,jpg}').test('a/b.jpg'))
})

test('parsers', () => {
  assert.deepEqual(parseStat('regular file|12|1700000000|644\n'), {
    type: 'file',
    size: 12,
    mtimeMs: 1700000000000,
    mode: 0o644,
  })
  assert.equal(parseStat('MISSING'), null)
  const entries = parseReaddir('b.txt|regular file|3|1\na|b|directory|0|2\n')
  assert.deepEqual(
    entries.map(e => [e.name, e.type]),
    [
      ['a|b', 'dir'],
      ['b.txt', 'file'],
    ],
  )
  const g = parseGrep('./src/a.ts:3:const x = 1\n./src/b.js:9:x\n', { glob: 'src/*.ts' })
  assert.deepEqual(g.matches, [{ path: 'src/a.ts', line: 3, text: 'const x = 1' }])
  assert.deepEqual(filterGlob('.\n./a\n./a/b.txt\n./c.md\n', '*.txt').paths, ['a/b.txt'])
})

test('adb environment over a fake device', { skip: hasSh ? false : 'no POSIX sh available' }, async () => {
  const devices = await listAdbDevices(FAKE)
  assert.equal(devices[0]?.serial, 'emulator-5554')
  assert.equal(devices[0].model, 'Fake_Phone')
  const env = new AdbEnvironment({ id: 'fake', name: 'Fake', serial: 'emulator-5554', adb: FAKE })
  await env.open()
  assert.equal(env.info?.os, 'android')
  assert.equal(env.android?.release, '14')
  const root = `/tmp/dsh-adb-test-${process.pid}`
  await env.mkdir(`${root}/sub`, { recursive: true })
  await env.writeFile(`${root}/sub/hello.txt`, Buffer.from('hello device\nline 2\n'))
  assert.equal((await env.readFile(`${root}/sub/hello.txt`)).toString(), 'hello device\nline 2\n')
  assert.equal((await env.readFile(`${root}/sub/hello.txt`, { offset: 6, length: 6 })).toString(), 'device')
  const st = await env.stat(`${root}/sub/hello.txt`)
  assert.equal(st?.type, 'file')
  assert.equal(st.size, 20)
  assert.equal(await env.stat(`${root}/nope`), null)
  const list = await env.readdir(`${root}/sub`)
  assert.deepEqual(
    list.map(e => e.name),
    ['hello.txt'],
  )
  const g = await env.glob('**/*.txt', { cwd: root })
  assert.deepEqual(g.paths, ['sub/hello.txt'])
  const r = await env.grep('device', { cwd: root })
  assert.equal(r.matches[0]?.path, 'sub/hello.txt')
  const ex = await env.exec({ command: 'echo from-device; exit 4' })
  assert.equal(ex.code, 4)
  assert.match(ex.stdout.toString(), /from-device/)
  await env.rename(`${root}/sub/hello.txt`, `${root}/sub/renamed.txt`)
  assert.ok(await env.stat(`${root}/sub/renamed.txt`))
  const fwd = await env.forward({ remotePort: 8080 })
  assert.equal(fwd.localPort, 45678)
  await fwd.close()
  await env.remove(root, { recursive: true })
  assert.equal(await env.stat(root), null)
})
