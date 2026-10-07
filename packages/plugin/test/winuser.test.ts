import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  privateDesktopName,
  sessionShellCommand,
  sharedBinary,
  windowsAccountLaunchArgs,
} from '../src/env/winuser/winuser-env.ts'
import { EnvironmentManager } from '../src/manager/manager.ts'

test('the session shell command quotes paths and carries the serve arguments', () => {
  const plain = sessionShellCommand('C:\\bin\\dsh-env-server.exe', 7000, 'tok')
  assert.deepEqual(plain.split(' ').slice(0, 4), ['C:\\bin\\dsh-env-server.exe', 'serve', '--listen', '127.0.0.1:7000'])
  assert.ok(plain.endsWith('--cwd ~'), plain)
  const spaced = sessionShellCommand('C:\\Program Files\\dsh\\srv.exe', 1, 't', 'C:\\work dir')
  assert.ok(spaced.startsWith('"C:\\Program Files\\dsh\\srv.exe" serve'), spaced)
  assert.ok(spaced.endsWith('"C:\\work dir"'), spaced)
})

test('the desktop mode is normalized and only kept for accounts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-cfg-'))
  try {
    const m = new EnvironmentManager({ dataDir: dir, autoDiscoverAdb: false })
    m.load()
    assert.equal(
      m.upsert({ name: 'W', kind: 'winuser', config: { account: 'a', desktop: 'private' } }).config.desktop,
      'private',
    )
    assert.equal(m.upsert({ name: 'W2', kind: 'winuser', config: { account: 'b' } }).config.desktop, 'shared')
    assert.equal(
      m.upsert({ name: 'W3', kind: 'winuser', config: { account: 'c', desktop: 'session' } }).config.desktop,
      'session',
    )
    assert.equal(
      m.upsert({ name: 'W4', kind: 'winuser', config: { account: 'd', desktop: 'nonsense' } }).config.desktop,
      'shared',
    )
    const srv = m.upsert({ name: 'S', kind: 'server', config: { host: 'h', port: 1, desktop: 'private' } })
    assert.equal(srv.config.desktop, undefined, 'other kinds never carry a desktop mode')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('private desktop names stay legal', () => {
  assert.equal(privateDesktopName('User1'), 'dsh-user1')
  assert.equal(privateDesktopName('a b\\c/d'), 'dsh-a_b_c_d')
  assert.equal(privateDesktopName(''), 'dsh-account')
  assert.ok(privateDesktopName('x'.repeat(80)).length <= 44)
})

test('launch arguments only add --desktop for the private mode', () => {
  const base = { account: 'User1', secretFile: 's', binary: 'bin.exe', port: 1234, token: 'tok' }
  const shared = windowsAccountLaunchArgs(base)
  assert.equal(shared.includes('--desktop'), false)
  assert.deepEqual(shared.slice(0, 6), ['winuser', 'launch', '--name', 'User1', '--secret-file', 's'])
  assert.ok(shared.includes('--supervise'), 'the desktop must be held by a supervising launcher')
  assert.deepEqual(shared.slice(-10), [
    '--',
    'bin.exe',
    'serve',
    '--listen',
    '127.0.0.1:1234',
    '--token',
    'tok',
    '--once',
    '--cwd',
    '~',
  ])

  const priv = windowsAccountLaunchArgs({ ...base, desktop: 'private' })
  const at = priv.indexOf('--desktop')
  assert.ok(at > 0, 'private mode passes --desktop')
  assert.equal(priv[at + 1], 'dsh-user1')
  assert.equal(priv.indexOf('--supervise'), 6)

  const withCwd = windowsAccountLaunchArgs({ ...base, cwd: 'C:\\work', desktop: 'private' })
  assert.equal(withCwd[withCwd.indexOf('--cwd') + 1], 'C:\\work')
})

test('sharedBinary copies by content hash and replaces tampered or old copies', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shared-bin-'))
  try {
    const src = path.join(tmp, 'src.exe')
    fs.writeFileSync(src, 'binary v1')
    const base = path.join(tmp, 'ProgramData')
    const a = sharedBinary(src, base)
    assert.equal(path.dirname(a), path.join(base, 'dsh-env'))
    assert.match(path.basename(a), /^dsh-env-server-[0-9a-f]{16}\.exe$/)
    assert.equal(fs.readFileSync(a, 'utf8'), 'binary v1')
    assert.equal(sharedBinary(src, base), a)

    fs.writeFileSync(a, 'tampered')
    assert.equal(sharedBinary(src, base), a)
    assert.equal(fs.readFileSync(a, 'utf8'), 'binary v1')

    fs.writeFileSync(src, 'binary v2')
    const b = sharedBinary(src, base)
    assert.notEqual(b, a)
    assert.equal(fs.existsSync(a), false, 'old version removed')
    assert.deepEqual(fs.readdirSync(path.dirname(b)), [path.basename(b)])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
