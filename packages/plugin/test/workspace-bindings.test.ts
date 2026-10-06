// Workspace ↔ environment binding: defaults, mount precedence, availability and the HTTP actions.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createActions, parseDefaultMount } from '../src/api/actions.ts'
import type { Borrowing } from '../src/borrowing/index.ts'
import type { AdbDevice } from '../src/env/adb/devices.ts'
import type { PluginContext } from '../src/host-api.ts'
import { AvailabilityChecker, isUnavailable } from '../src/manager/availability.ts'
import { EnvironmentManager } from '../src/manager/manager.ts'
import type { Mounting } from '../src/mount/index.ts'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-env-bind-'))

function setup() {
  const dir = tmp()
  const m = new EnvironmentManager({ dataDir: dir, autoDiscoverAdb: false })
  m.load()
  m.upsert({ id: 'box', name: 'Box', kind: 'server', config: { host: 'box.lan', port: 7461 } })
  m.upsert({ id: 'pixel', name: 'Pixel', kind: 'adb', config: { serial: 'PX1' } })
  return { dir, m, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

const device = (serial: string, state = 'device'): AdbDevice => ({
  serial,
  state,
  model: undefined,
  product: undefined,
  device: undefined,
  transportId: undefined,
  emulator: false,
})

test('workspace settings patch only the given keys', () => {
  const { m, cleanup } = setup()
  m.setWorkspaceSettings('/ws', { borrowable: ['local'] })
  m.setWorkspaceDefaultMount('/ws', { envId: 'box', remoteRoot: '/srv' })
  assert.deepEqual(m.workspaceSettings('/ws'), {
    borrowable: ['local'],
    defaultMount: { envId: 'box', remoteRoot: '/srv' },
  })
  m.setWorkspaceSettings('/ws', { borrowable: null })
  assert.deepEqual(m.workspaceSettings('/ws'), { defaultMount: { envId: 'box', remoteRoot: '/srv' } })
  m.setWorkspaceDefaultMount('/ws', null)
  assert.deepEqual(m.workspaceSettings('/ws'), {})
  assert.equal(Object.keys(m.state.workspaces).length, 0, 'empty settings are dropped')
  assert.throws(() => m.setWorkspaceDefaultMount('/ws', { envId: 'nope' }), /unknown environment/)
  cleanup()
})

test('bindings: remote workspace, default environment, host', () => {
  const { dir, m, cleanup } = setup()
  const ws = m.addRemoteWorkspace({ envId: 'box', root: '/srv/app', mountsDir: path.join(dir, 'mounts') })
  ws.workspaceId = 'w-remote'
  m.setWorkspaceDefaultMount('/ws', { envId: 'pixel' })

  const remote = m.workspaceBinding(ws.hostPath)
  assert.equal(remote.kind, 'remote')
  assert.equal(remote.envId, 'box')
  assert.equal(remote.remoteRoot, '/srv/app')
  assert.equal(remote.remoteWorkspace?.id, ws.id)
  // Found by workspace id even when the path spelling differs.
  assert.equal(m.workspaceBinding('/elsewhere', 'w-remote').kind, 'remote')

  assert.deepEqual(m.workspaceBinding('/ws'), {
    kind: 'default',
    envId: 'pixel',
    remoteRoot: undefined,
    borrowable: undefined,
  })
  assert.deepEqual(m.workspaceBinding('/other'), { kind: 'host', borrowable: undefined })
  assert.throws(() => m.setWorkspaceDefaultMount(ws.hostPath, { envId: 'local' }), /remote workspace/)
  cleanup()
})

test('the workspace default mounts only fresh sessions and is pinned once applied', () => {
  const { m, cleanup } = setup()
  m.setWorkspaceDefaultMount('/ws', { envId: 'box', remoteRoot: '/srv' })

  // An already-started (resumed) session is not moved onto the default.
  assert.equal(m.mountFor('old', '/ws'), undefined)
  // A fresh session previews it.
  const want = m.mountFor('new', '/ws', { fresh: true })
  assert.deepEqual(want, { envId: 'box', remoteRoot: '/srv', hostRoot: '/ws', source: 'default' })

  // Once mounted, the choice is persisted in the session …
  assert.ok(want)
  m.seedDefaultMount('new', want)
  assert.equal(m.sessionSettings('new').mountOrigin, 'default')
  // … so changing the workspace default later does not move it.
  m.setWorkspaceDefaultMount('/ws', { envId: 'pixel' })
  assert.equal(m.mountFor('new', '/ws')?.envId, 'box')
  assert.equal(m.mountFor('new', '/ws')?.source, 'default')

  // "Don't mount" on a fresh session overrides the default.
  m.setSessionSettings('skip', { mount: false })
  assert.equal(m.mountFor('skip', '/ws', { fresh: true }), undefined)

  // An explicit session mount wins and is reported as such.
  m.setSessionSettings('own', { mount: { envId: 'local' } })
  assert.equal(m.mountFor('own', '/ws', { fresh: true })?.source, 'session')
  cleanup()
})

test('availability: local, tcp probes, adb devices and unknown definitions', async () => {
  const { m, cleanup } = setup()
  m.upsert({ id: 'shell', name: 'Shell', kind: 'ssh', config: { host: 'down.lan' } })
  m.upsert({ id: 'tablet', name: 'Tablet', kind: 'adb', config: { serial: 'TB1' } })
  m.upsert({ id: 'gone', name: 'Gone', kind: 'adb', config: { serial: 'GONE' } })
  const probed: string[] = []
  const checker = new AvailabilityChecker(m, {
    tcpProbe: async (host, port) => {
      probed.push(`${host}:${port}`)
      if (host === 'down.lan') throw new Error('ECONNREFUSED')
    },
    listAdb: async () => [device('PX1'), device('TB1', 'unauthorized')],
  })
  const a = await checker.check(['local', 'box', 'shell', 'pixel', 'tablet', 'gone', 'deleted'])
  assert.equal(a['local']?.state, 'available')
  assert.equal(a['box']?.state, 'available')
  assert.equal(a['shell']?.state, 'offline')
  assert.match(a['shell']?.reason ?? '', /down\.lan:22/)
  assert.equal(a['pixel']?.state, 'available')
  assert.equal(a['tablet']?.state, 'offline')
  assert.match(a['tablet']?.reason ?? '', /unauthorized/)
  assert.equal(a['gone']?.state, 'offline')
  assert.match(a['gone']?.reason ?? '', /not connected/)
  assert.equal(a['deleted']?.state, 'error')
  assert.deepEqual(probed.sort(), ['box.lan:7461', 'down.lan:22'])

  // Cached within the TTL; invalidate() forces a new probe.
  await checker.check(['box'])
  assert.equal(probed.length, 2)
  checker.invalidate('box')
  await checker.check(['box'])
  assert.equal(probed.length, 3)

  assert.equal(isUnavailable('offline'), true)
  assert.equal(isUnavailable('error'), true)
  assert.equal(isUnavailable('busy'), false)
  assert.equal(isUnavailable('unknown'), false)
  cleanup()
})

test('availability: adb lister failure is an error, slow probes report unknown first', async () => {
  const { m, cleanup } = setup()
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const checker = new AvailabilityChecker(m, {
    tcpProbe: () => gate,
    listAdb: async () => {
      throw new Error('adb not found')
    },
  })
  const first = await checker.check(['box', 'pixel'], { waitMs: 20 })
  assert.equal(first['box']?.state, 'unknown')
  assert.equal(first['pixel']?.state, 'error')
  assert.match(first['pixel']?.reason ?? '', /adb not found/)
  release()
  await new Promise(resolve => setTimeout(resolve, 10))
  const second = await checker.check(['box'], { waitMs: 20 })
  assert.equal(second['box']?.state, 'available')
  cleanup()
})

test('HTTP actions: workspace.set patches, workspace.bindings reports bindings with availability', async () => {
  const { dir, m, cleanup } = setup()
  const ws = m.addRemoteWorkspace({ envId: 'pixel', root: '/sdcard/app', mountsDir: path.join(dir, 'mounts') })
  ws.workspaceId = 'w-remote'
  const registry = new Map([['w-host', { path: '/projects/site' }]])
  const ctx = {
    get: (name: string) => (name === 'workspaceRegistry' ? { get: (id: string) => registry.get(id) } : undefined),
  } as unknown as PluginContext
  const actions = createActions(ctx, m, {
    mounting: {} as Mounting,
    borrowing: {} as Borrowing,
    mountsDir: path.join(dir, 'mounts'),
    availability: new AvailabilityChecker(m, {
      tcpProbe: async () => {
        throw new Error('timeout')
      },
      listAdb: async () => [],
    }),
  })
  const call = (name: string, body: Record<string, unknown>) => {
    const action = actions[name]
    assert.ok(action, `action ${name}`)
    return action(body)
  }

  await call('workspace.set', { workspaceId: 'w-host', borrowable: ['local'] })
  const set = (await call('workspace.set', {
    workspaceId: 'w-host',
    defaultMount: { envId: 'box', remoteRoot: '/srv' },
  })) as {
    settings: unknown
    binding: { kind: string }
  }
  assert.deepEqual(set.settings, { borrowable: ['local'], defaultMount: { envId: 'box', remoteRoot: '/srv' } })
  assert.equal(set.binding.kind, 'default')
  await assert.rejects(call('workspace.set', { workspaceId: 'missing', defaultMount: null }), /workspace not found/)
  await assert.rejects(
    call('workspace.set', { workspaceId: 'w-remote', defaultMount: { envId: 'box' } }),
    /remote workspace/,
  )

  const result = (await call('workspace.bindings', {
    workspaces: [
      { workspaceId: 'w-host', path: '/projects/site' },
      { workspaceId: 'w-remote', path: ws.hostPath },
      { workspaceId: 'w-plain', path: '/plain' },
      'garbage',
    ],
  })) as {
    bindings: { workspaceId: string; kind: string; envId?: string }[]
    availability: Record<string, { state: string }>
    environments: { id: string; name: string; kind: string }[]
  }
  assert.deepEqual(
    result.bindings.map(b => [b.workspaceId, b.kind, b.envId]),
    [
      ['w-host', 'default', 'box'],
      ['w-remote', 'remote', 'pixel'],
      ['w-plain', 'host', undefined],
    ],
  )
  assert.equal(result.availability['box']?.state, 'offline')
  assert.equal(result.availability['pixel']?.state, 'offline')
  assert.deepEqual(result.environments.map(e => e.id).sort(), ['box', 'pixel'])

  // A workspace given by id only is resolved through the DSH workspace registry.
  const byId = (await call('workspace.bindings', {
    workspaces: [{ workspaceId: 'w-host' }, { workspaceId: 'nope' }],
  })) as {
    bindings: { path: string; kind: string }[]
  }
  assert.deepEqual(
    byId.bindings.map(b => [b.path, b.kind]),
    [['/projects/site', 'default']],
  )

  // Clearing the default leaves the borrowable list alone.
  await call('workspace.set', { workspacePath: '/projects/site', defaultMount: null })
  assert.deepEqual(m.workspaceSettings('/projects/site'), { borrowable: ['local'] })
  cleanup()
})

test('parseDefaultMount validates its input', () => {
  assert.equal(parseDefaultMount(null), null)
  assert.equal(parseDefaultMount(false), null)
  assert.deepEqual(parseDefaultMount({ envId: 'box' }), { envId: 'box' })
  assert.deepEqual(parseDefaultMount({ envId: 'box', remoteRoot: '/srv' }), { envId: 'box', remoteRoot: '/srv' })
  assert.throws(() => parseDefaultMount({}), /envId/)
  assert.throws(() => parseDefaultMount('box'), /defaultMount/)
})
