import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { FileSystem, FsError as FsErrorClass } from '@deepseek-ai/dsh-fs'
import { Environment } from '../src/env/environment.ts'
import { openLocal } from '../src/env/server/connect.ts'
import { aliasFor } from '../src/manager/definitions.ts'
import { EnvironmentManager } from '../src/manager/manager.ts'
import { createEnvFileSystem } from '../src/mount/fs-provider.ts'
import { loadInstructions } from '../src/mount/instructions.ts'
import { MountMap } from '../src/mount/map.ts'
import { needsServer } from './helpers.ts'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-env-mgr-'))

test('definitions, secrets and settings', () => {
  const dir = tmp()
  const m = new EnvironmentManager({ dataDir: dir, autoDiscoverAdb: false })
  m.load()
  assert.equal(m.definitions()[0]?.id, 'local')
  const def = m.upsert({ name: 'Build Box', kind: 'server', config: { host: 'h', port: '7461', token: 'tok' } })
  assert.equal(def.id, 'build_box')
  assert.equal(def.config.port, 7461)
  assert.equal(m.publicDef(def).config.token, '••••••')
  m.upsert({ id: 'build_box', name: 'Build Box', kind: 'server', config: { host: 'h2', port: 1, token: '••••••' } })
  assert.equal(m.get('build_box')?.config.token, 'tok')
  assert.throws(() => m.upsert({ name: 'x', kind: 'server', config: {} }), /host and port/)
  m.flush()
  const m2 = new EnvironmentManager({ dataDir: dir, autoDiscoverAdb: false })
  m2.load()
  assert.equal(m2.get('build_box')?.config.host, 'h2')
  assert.equal(aliasFor('9lives'), 'env_9lives')

  // borrowable inheritance: all → workspace → session
  assert.equal(m2.borrowableFor('s1', '/ws').source, 'all')
  m2.setWorkspaceSettings('/ws', { borrowable: ['local'] })
  assert.deepEqual(
    m2.borrowableFor('s1', '/ws').defs.map(d => d.id),
    ['local'],
  )
  assert.equal(m2.borrowableFor('s1', '/ws').source, 'workspace')
  m2.setSessionSettings('s1', { borrowable: ['build_box'] })
  assert.deepEqual(
    m2.borrowableFor('s1', '/ws').defs.map(d => d.id),
    ['build_box'],
  )
  fs.rmSync(dir, { recursive: true, force: true })
})

test('remote workspaces drive the mount decision', () => {
  const dir = tmp()
  const m = new EnvironmentManager({ dataDir: dir, autoDiscoverAdb: false })
  m.load()
  const ws = m.addRemoteWorkspace({ envId: 'local', root: '/srv/app', mountsDir: path.join(dir, 'mounts') })
  assert.ok(fs.existsSync(ws.hostPath))
  const mount = m.mountFor('s1', ws.hostPath)
  assert.equal(mount?.envId, 'local')
  assert.equal(mount.remoteRoot, '/srv/app')
  assert.equal(m.mountFor('s1', path.join(ws.hostPath, 'sub'))?.source, 'workspace')
  m.setSessionSettings('s1', { mount: false })
  assert.equal(m.mountFor('s1', ws.hostPath), undefined)
  assert.equal(m.mountFor('s2', os.homedir()), undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Connection stub so leasing logic can be tested without a device. */
class StubEnvironment extends Environment {}

test('exclusive leases queue in order', async () => {
  const dir = tmp()
  const m = new EnvironmentManager({ dataDir: dir, autoDiscoverAdb: false })
  m.load()
  m.upsert({ id: 'phone', name: 'Phone', kind: 'server', headlessParallel: false, config: { host: '127.0.0.1', port: 1 } })
  m.open = def => {
    const e = new StubEnvironment({ id: def.id, name: def.name, kind: def.kind })
    e.info = {
      os: 'linux',
      family: 'posix',
      arch: '',
      hostname: '',
      user: '',
      home: '',
      cwd: '/',
      pathSep: '/',
      shell: '',
      caps: [],
      version: '',
    }
    return Promise.resolve(e)
  }
  const a = await m.acquire('phone', { owner: { sessionId: 'a' } })
  await assert.rejects(m.acquire('phone', { owner: { sessionId: 'b' } }), { code: 'EBUSY' })
  const waiting = m.acquire('phone', { owner: { sessionId: 'b' }, wait: true, timeoutMs: 5000 })
  await new Promise(r => setTimeout(r, 50))
  const phone = m.get('phone')
  assert.ok(phone)
  assert.equal(m.status(phone).queue.length, 1)
  await a.release()
  const b = await waiting
  assert.equal(b.owner?.sessionId, 'b')
  const controller = new AbortController()
  const c = m.acquire('phone', { owner: { sessionId: 'c' }, wait: true, signal: controller.signal })
  controller.abort()
  await assert.rejects(c, { code: 'CANCELLED' })
  await assert.rejects(m.acquire('phone', { owner: { sessionId: 'd' }, wait: true, timeoutMs: 50 }), {
    code: 'ETIMEDOUT',
  })
  await b.release()
  assert.equal(m.leases.size, 0)
  await m.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('mounted FileSystem provider maps the host placeholder into the environment', needsServer, async () => {
  const root = tmp()
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\r\ntwo\r\n')
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Rule: be kind')
  // Minimal stand-ins for the harness base classes.
  class FsError extends Error {
    readonly code: string
    constructor(m: string, code: string) {
      super(m)
      this.code = code
    }
  }
  class FakeFileSystem {
    readonly ctx: unknown
    constructor(ctx: unknown) {
      this.ctx = ctx
    }
  }
  const EnvFileSystem = createEnvFileSystem({
    FileSystem: FakeFileSystem as unknown as typeof FileSystem,
    FsError: FsError as unknown as typeof FsErrorClass,
  })
  const env = await openLocal({ id: 'local', cwd: root })
  try {
    const hostRoot = path.join(os.tmpdir(), 'placeholder-x')
    const map = new MountMap({ env, hostRoot, remoteRoot: root })
    const fsx = new EnvFileSystem({} as never, { map })
    const t = await fsx.resolve('a.txt', { cwd: hostRoot })
    assert.equal(t.targetKey, path.join(root, 'a.txt'))
    const t2 = await fsx.resolve(path.join(hostRoot, 'a.txt'))
    assert.equal(t2.targetKey, t.targetKey)
    assert.equal(await fsx.readText(t), 'one\r\ntwo\r\n')
    const info = await fsx.stat(t)
    assert.equal(info?.type, 'file')
    const edit = await fsx.editText(
      t,
      { oldString: 'two', newString: 'three', replaceAll: false },
      { version: info.version },
    )
    assert.equal(edit.after, 'one\nthree\n')
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\r\nthree\r\n')
    await assert.rejects(
      fsx.editText(t, { oldString: 'three', newString: 'x', replaceAll: false }, { version: info.version }),
      { code: 'FS_STALE_VERSION' },
    )
    const created = await fsx.writeText(await fsx.resolve('new/b.txt', { cwd: hostRoot }), 'hi')
    assert.equal(created.operation, 'create')
    await assert.rejects(
      fsx.writeText(await fsx.resolve('new/b.txt', { cwd: hostRoot }), 'x', { kind: 'createIfAbsent' }),
      {
        code: 'FS_NOT_OBSERVED',
      },
    )
    const listing = await fsx.listDir(await fsx.resolve('.', { cwd: hostRoot }))
    assert.deepEqual(listing.map(e => e.name).sort(), ['AGENTS.md', 'a.txt', 'new'])
    assert.equal(await fsx.stat(await fsx.resolve('missing')), undefined)
    assert.ok(fsx.contains(await fsx.resolve('.', { cwd: hostRoot }), t))
    const text = await loadInstructions(env, root)
    assert.match(text, /Rule: be kind/)
  } finally {
    await env.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
