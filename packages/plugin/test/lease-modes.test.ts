// Lease modes: headless leases in parallel, one GUI holder at a time, upgrades / downgrades,
// mounts (GUI mode, returning the GUI keeps the mount), subagents sharing their parent's mount,
// and the migration of the old `exclusive` flag.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Stat } from '@dsh-environments/protocol'
import { installBorrowing } from '../src/borrowing/index.ts'
import type { HarnessDeps } from '../src/deps.ts'
import { Environment } from '../src/env/environment.ts'
import type { Agent, PluginContext, PreStepDecision, PreStepEvent } from '../src/host-api.ts'
import { EnvironmentManager } from '../src/manager/manager.ts'
import { installMounting, MountBlockedError } from '../src/mount/index.ts'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-env-modes-'))
const tick = () => new Promise(resolve => setTimeout(resolve, 10))

/** A device with a screen and one directory, `/srv/app`. */
class StubEnvironment extends Environment {
  override stat(p: string): Promise<Stat | null> {
    return Promise.resolve(p === '/srv/app' ? ({ type: 'dir', size: 0, mtimeMs: 0 } as unknown as Stat) : null)
  }
  realpath(p: string): Promise<string> {
    return Promise.resolve(p)
  }
}

function manager(dir = tmp()) {
  const m = new EnvironmentManager({ dataDir: dir, autoDiscoverAdb: false })
  m.load()
  m.upsert({ id: 'phone', name: 'Phone', kind: 'server', config: { host: '127.0.0.1', port: 1 } })
  m.upsert({ id: 'solo', name: 'Solo', kind: 'server', headlessParallel: false, config: { host: '127.0.0.1', port: 2 } })
  const opened: string[] = []
  m.open = def => {
    opened.push(def.id)
    const e = new StubEnvironment({ id: def.id, name: def.name, kind: def.kind })
    e.info = {
      os: 'linux',
      family: 'posix',
      arch: '',
      hostname: '',
      user: 'u',
      home: '/',
      cwd: '/srv/app',
      pathSep: '/',
      shell: '/bin/sh',
      caps: ['screenshot', 'input'],
      version: '',
    }
    return Promise.resolve(e)
  }
  const def = (id: string) => {
    const d = m.get(id)
    assert.ok(d)
    return d
  }
  return {
    m,
    dir,
    opened,
    def,
    cleanup: async () => {
      await m.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('headless leases run in parallel; the GUI is held by one lease at a time, FIFO', async () => {
  const { m, def, cleanup } = manager()
  const a = await m.acquire('phone', { owner: { sessionId: 'a' } })
  const b = await m.acquire('phone', { owner: { sessionId: 'b' } })
  assert.equal(m.status(def('phone')).busy, false)
  const g = await m.acquire('phone', { owner: { sessionId: 'g' }, mode: 'gui' })
  assert.equal(g.mode, 'gui')
  assert.equal(m.status(def('phone')).gui?.sessionId, 'g')
  assert.equal(m.status(def('phone')).guiBusy, true)
  // Headless still admitted next to a GUI holder.
  const c = await m.acquire('phone', { owner: { sessionId: 'c' } })
  // A second GUI request fails fast or queues; upgrades queue behind earlier GUI waiters.
  await assert.rejects(m.acquire('phone', { owner: { sessionId: 'x' }, mode: 'gui' }), {
    code: 'EBUSY',
    message: /GUI of Phone is in use by g/,
  })
  await assert.rejects(m.setGui(a, 'a', true), { code: 'EBUSY' })
  const order: string[] = []
  const upA = m.setGui(a, 'a', true, { wait: true, timeoutMs: 5000 }).then(() => order.push('a'))
  const newD = m.acquire('phone', { owner: { sessionId: 'd' }, mode: 'gui', wait: true, timeoutMs: 5000 })
  void newD.then(() => order.push('d'))
  await tick()
  assert.deepEqual(
    m.status(def('phone')).queue.map(q => [q.sessionId, q.mode, q.upgrade]),
    [
      ['a', 'gui', true],
      ['d', 'gui', false],
    ],
  )
  // Downgrade of the holder admits the first waiter only.
  await m.setGui(g, 'g', false)
  assert.equal(g.mode, 'headless')
  await upA
  assert.equal(a.mode, 'gui')
  assert.deepEqual(order, ['a'])
  // Releasing the GUI lease admits the next one.
  await a.release()
  const d = await newD
  assert.equal(d.mode, 'gui')
  assert.deepEqual(order, ['a', 'd'])
  for (const l of [b, c, d, g]) await l.release()
  assert.equal(m.leases.size, 0)
  await cleanup()
})

test('a non-parallel environment admits one lease of either mode; its holder upgrades at once', async () => {
  const { m, def, cleanup } = manager()
  const a = await m.acquire('solo', { owner: { sessionId: 'a' } })
  assert.equal(m.status(def('solo')).busy, true)
  await assert.rejects(m.acquire('solo', { owner: { sessionId: 'b' } }), { code: 'EBUSY' })
  await assert.rejects(m.acquire('solo', { owner: { sessionId: 'a' } }), { code: 'EEXIST' })
  const waiting = m.acquire('solo', { owner: { sessionId: 'b' }, wait: true, timeoutMs: 5000 })
  await tick()
  // The only holder upgrades even with someone queued behind it.
  await m.setGui(a, 'a', true)
  assert.equal(a.mode, 'gui')
  await m.setGui(a, 'a', false)
  assert.equal(m.leases.size, 1, 'a downgrade does not let a headless waiter in')
  await a.release()
  const b = await waiting
  assert.equal(b.owner?.sessionId, 'b')
  await b.release()
  await cleanup()
})

test('a request admitted while its connection opens holds its place', async () => {
  const { m, cleanup } = manager()
  const open = m.open
  let finish: () => void = () => {}
  m.open = (d, o) =>
    new Promise(resolve => {
      finish = () => resolve(open(d, o))
    })
  const first = m.acquire('phone', { owner: { sessionId: 'a' }, mode: 'gui' })
  await tick()
  await assert.rejects(m.acquire('phone', { owner: { sessionId: 'b' }, mode: 'gui' }), { code: 'EBUSY' })
  finish()
  const a = await first
  m.open = open
  await a.release()
  const b = await m.acquire('phone', { owner: { sessionId: 'b' }, mode: 'gui' })
  await b.release()
  await cleanup()
})

test('upgrade waits time out, cancel, and end with the lease', async () => {
  const { m, def, cleanup } = manager()
  const g = await m.acquire('phone', { owner: { sessionId: 'g' }, mode: 'gui' })
  const a = await m.acquire('phone', { owner: { sessionId: 'a' } })
  await assert.rejects(m.setGui(a, 'a', true, { wait: true, timeoutMs: 30 }), { code: 'ETIMEDOUT' })
  const controller = new AbortController()
  const cancelled = m.setGui(a, 'a', true, { wait: true, signal: controller.signal })
  controller.abort()
  await assert.rejects(cancelled, { code: 'CANCELLED' })
  const pending = m.setGui(a, 'a', true, { wait: true, timeoutMs: 5000 })
  await a.release()
  await g.release()
  await assert.rejects(pending, { code: 'ECLOSED' })
  assert.equal(m.status(def('phone')).queue.length, 0)
  await cleanup()
})

test('the exclusive flag migrates to headlessParallel; upsert keeps and clears lease settings', async () => {
  const dir = tmp()
  fs.writeFileSync(
    path.join(dir, 'environments.json'),
    JSON.stringify({
      version: 1,
      environments: [
        { id: 'p', name: 'P', kind: 'adb', exclusive: true, config: { serial: 'x' } },
        { id: 'w', name: 'W', kind: 'winuser', exclusive: false, config: { account: 'w' } },
        { id: 's', name: 'S', kind: 'server', exclusive: true, config: { host: 'h', port: 1 } },
        { id: 't', name: 'T', kind: 'ssh', exclusive: false, config: { host: 'h' } },
      ],
      workspaces: {},
      sessions: {},
      remoteWorkspaces: [],
    }),
  )
  const m = new EnvironmentManager({ dataDir: dir, autoDiscoverAdb: false, mountMode: 'gui' })
  m.load()
  const raw = (id: string) => m.state.environments.find(e => e.id === id) as unknown as Record<string, unknown>
  for (const id of ['p', 'w', 's', 't']) assert.equal('exclusive' in raw(id), false)
  assert.equal(raw('p')['headlessParallel'], undefined, 'adb: was exclusive by default, now parallel headless')
  assert.equal(raw('s')['headlessParallel'], false, 'an explicit exclusive server stays exclusive')
  assert.equal(raw('t')['headlessParallel'], undefined)
  assert.equal(m.state.version, 2)
  m.flush()
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'environments.json'), 'utf8')) as { version: number }
  assert.equal(saved.version, 2)

  const s = m.require('s')
  assert.equal(m.publicDef(s).headlessParallel, false)
  assert.equal(m.publicDef(s).effectiveMountMode, 'gui', 'plugin default')
  m.upsert({ id: 's', name: 'S', kind: 'server', mountMode: 'headless', config: { host: 'h', port: 1 } })
  assert.equal(m.require('s').headlessParallel, false, 'absent in the input: kept')
  assert.equal(m.publicDef(m.require('s')).effectiveMountMode, 'headless')
  m.upsert({ id: 's', name: 'S', kind: 'server', headlessParallel: true, mountMode: null, config: { host: 'h', port: 1 } })
  assert.equal(m.require('s').headlessParallel, undefined)
  assert.equal(m.require('s').mountMode, undefined)
  await m.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------------------ tools, mounts and subagents

type Listener = (...args: never[]) => unknown
interface FakeTool {
  name: string
  execute(args: Record<string, unknown>, exec: { agent: Agent; signal: AbortSignal }): Promise<string>
}

/** A host that keeps the tools visible to each agent, as scopes register and dispose them. */
function host(m: EnvironmentManager) {
  const hooks = new Map<string, Listener[]>()
  const global = new Map<string, FakeTool>()
  const visible = new Map<Agent, Set<string>>()
  const agents = new Map<string, Agent>()
  const noop = () => () => {}
  const makeCtx = (register: (t: FakeTool) => () => void): PluginContext => {
    const ctx = {
      on(name: string, listener: Listener) {
        hooks.set(name, [...(hooks.get(name) ?? []), listener])
        return () => {}
      },
      tools: { register, restrict: noop, schemas: () => [] },
      systemPrompt: { getSectionOrder: () => 900, section: noop, variable: noop },
      logger: () => ({ info() {}, warn() {} }),
      effect: () => undefined,
      isolate: () => ctx,
      plugin: () => undefined,
      get: (name: string) => (name === 'agents' ? { get: (id: string) => agents.get(id) } : undefined),
    }
    return ctx as unknown as PluginContext
  }
  const ctx = makeCtx(t => {
    global.set(t.name, t)
    return () => global.delete(t.name)
  })
  class FakeBase {
    constructor(_ctx: unknown) {}
  }
  const deps = {
    defineTool: (definition: unknown) => definition,
    createScope: (_ctx: PluginContext, agent: Agent) => {
      const own = new Set<string>()
      const set = visible.get(agent) ?? new Set<string>()
      visible.set(agent, set)
      return {
        ctx: makeCtx(t => {
          own.add(t.name)
          set.add(t.name)
          return () => set.delete(t.name)
        }),
        dispose: async () => {
          for (const n of own) set.delete(n)
        },
      }
    },
    FileSystem: FakeBase,
    FsError: Error,
    SubprocessRuntime: FakeBase,
    SubprocessExecutableNotFoundError: Error,
    BashLocal: {},
    PwshLocal: {},
    ToolBash: {},
    ToolPwsh: {},
    ToolFs: {},
    SkillFilesystem: undefined,
  } as unknown as HarnessDeps
  const mounting = installMounting(ctx, m, deps)
  const borrowing = installBorrowing(ctx, m, deps, { mountOf: a => mounting.mountOf(a), mountEvents: mounting.events })
  const agent = (id: string, cwd: string, parent?: string): Agent => {
    const a: Agent = {
      ctx,
      session: {
        id,
        header: { id, cwd, ...(parent ? { parentSession: parent, origin: 'subagent' } : {}) },
      },
    }
    agents.set(id, a)
    return a
  }
  const created = async (a: Agent) => {
    for (const l of hooks.get('agent/created') ?? []) await (l as (e: { agent: Agent }) => unknown)({ agent: a })
    await tick()
  }
  const call = (a: Agent, tool: string, args: Record<string, unknown>) => {
    const t = global.get(tool)
    assert.ok(t, tool)
    return t.execute(args, { agent: a, signal: new AbortController().signal })
  }
  // Lease tools only (a mount also registers its search tools).
  const tools = (a: Agent) => [...(visible.get(a) ?? [])].filter(n => n.includes('__')).sort()
  const preStep = (a: Agent) => {
    const [listener] = hooks.get('agent/pre-step') ?? []
    assert.ok(listener)
    return (listener as (e: PreStepEvent, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>)(
      { agent: a, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    )
  }
  return { mounting, borrowing, agent, created, call, tools, preStep }
}

test('env_borrow: headless by default, gui:true upgrades, gui:false / env_return gui_only downgrade', async () => {
  const { m, def, cleanup } = manager()
  const h = host(m)
  const a = h.agent('a', os.tmpdir())
  const b = h.agent('b', os.tmpdir())
  await h.created(a)
  await h.created(b)

  assert.match(await h.call(a, 'env_borrow', { environment: 'phone' }), /Borrowed Phone as "phone" \(headless/)
  assert.ok(h.tools(a).includes('phone__exec'))
  assert.ok(!h.tools(a).includes('phone__screenshot'), 'no GUI tools on a headless lease')

  assert.match(await h.call(a, 'env_borrow', { environment: 'phone', gui: true }), /Took the GUI/)
  assert.ok(h.tools(a).includes('phone__screenshot'))
  assert.ok(h.tools(a).includes('phone__input'))
  assert.deepEqual(m.sessionSettings('a').held, [{ envId: 'phone', alias: 'phone', gui: true }])

  // b borrows in parallel, but cannot take the GUI.
  assert.match(await h.call(b, 'env_borrow', { environment: 'phone' }), /headless/)
  await assert.rejects(h.call(b, 'env_borrow', { environment: 'phone', gui: true }), /GUI of Phone is in use/)
  assert.match(await h.call(b, 'env_list', {}), /GUI held by a/)

  // a gives the GUI back: its screen tools go, b can take it.
  assert.match(await h.call(a, 'env_return', { environment: 'phone', gui_only: true }), /stays headless/)
  assert.ok(!h.tools(a).includes('phone__screenshot'))
  assert.ok(h.tools(a).includes('phone__exec'))
  await h.call(b, 'env_borrow', { environment: 'phone', gui: true })
  assert.equal(m.status(def('phone')).gui?.sessionId, 'b')
  assert.match(await h.call(b, 'env_borrow', { environment: 'phone', gui: false }), /Gave back the GUI/)
  assert.equal(m.status(def('phone')).gui, undefined)

  await h.call(a, 'env_return', { environment: 'all' })
  assert.deepEqual(h.tools(a), [])
  assert.equal(m.sessionSettings('a').held, undefined)
  await cleanup()
})

test('mounts are headless by default; taking and returning the GUI keeps the mount', async () => {
  const { m, def, cleanup } = manager()
  const h = host(m)
  const a = h.agent('a', os.tmpdir())
  m.setSessionSettings('a', { mount: { envId: 'phone', remoteRoot: '/srv/app' } })
  await h.created(a)
  const record = h.mounting.mountOf(a)
  assert.ok(record)
  assert.equal(record.lease.mode, 'headless')
  assert.deepEqual(h.tools(a), [])

  assert.match(await h.call(a, 'env_borrow', { environment: 'phone' }), /mounted on Phone/)
  assert.match(await h.call(a, 'env_borrow', { environment: 'phone', gui: true }), /GUI of your mounted environment/)
  assert.equal(record.lease.mode, 'gui')
  assert.ok(h.tools(a).includes('phone__screenshot'))
  assert.ok(!h.tools(a).includes('phone__exec'), 'the mount covers files and the shell')
  assert.equal(m.sessionSettings('a').mountGui, true)
  assert.equal(m.leases.size, 1, 'no second lease')

  assert.match(await h.call(a, 'env_return', { environment: 'phone' }), /still mounted/)
  assert.equal(h.mounting.mountOf(a), record)
  assert.equal(record.lease.released, false)
  assert.equal(record.lease.mode, 'headless')
  assert.equal(m.status(def('phone')).gui, undefined)
  assert.deepEqual(h.tools(a), [])
  assert.equal(m.sessionSettings('a').mountGui, false)
  await assert.rejects(h.call(a, 'env_return', { environment: 'phone' }), /cannot be returned/)
  await cleanup()
})

test('mountMode gui takes the GUI when it is free and falls back to headless when it is not', async () => {
  const { m, cleanup } = manager()
  m.upsert({ id: 'phone', name: 'Phone', kind: 'server', mountMode: 'gui', config: { host: '127.0.0.1', port: 1 } })
  const h = host(m)
  const a = h.agent('a', os.tmpdir())
  m.setSessionSettings('a', { mount: { envId: 'phone', remoteRoot: '/srv/app' } })
  await h.created(a)
  assert.equal(h.mounting.mountOf(a)?.lease.mode, 'gui')
  assert.ok(h.tools(a).includes('phone__screenshot'))

  const b = h.agent('b', os.tmpdir())
  m.setSessionSettings('b', { mount: { envId: 'phone', remoteRoot: '/srv/app' } })
  await h.created(b)
  assert.equal(h.mounting.mountOf(b)?.lease.mode, 'headless', 'the GUI is held by a; b mounts headless')
  assert.deepEqual(h.tools(b), [])
  await cleanup()
})

test('session resume re-acquires borrowed leases in their mode, headless when the GUI is taken', async () => {
  const { m, cleanup } = manager()
  const h = host(m)
  m.setSessionSettings('a', { held: [{ envId: 'phone', alias: 'phone', gui: true }] })
  m.setSessionSettings('b', { held: [{ envId: 'phone', alias: 'phone', gui: true }] })
  const a = h.agent('a', os.tmpdir())
  await h.created(a)
  const b = h.agent('b', os.tmpdir())
  await h.created(b)
  assert.equal(h.borrowing.heldOf(a)[0]?.gui, true)
  assert.equal(h.borrowing.heldOf(b)[0]?.gui, false)
  assert.ok(h.tools(b).includes('phone__exec'))
  assert.deepEqual(m.sessionSettings('b').held, [{ envId: 'phone', alias: 'phone' }])
  await cleanup()
})

test('subagents share the mount and lease of their parent, and are gated when it is lost', async () => {
  const { m, opened, cleanup } = manager()
  const h = host(m)
  const parent = h.agent('p', os.tmpdir())
  m.setSessionSettings('p', { mount: { envId: 'solo', remoteRoot: '/srv/app' } })
  await h.created(parent)
  const parentRecord = h.mounting.mountOf(parent)
  assert.ok(parentRecord)

  // The exclusive environment does not deadlock: the child reuses the parent's lease.
  const child = h.agent('c', os.tmpdir(), 'p')
  await h.created(child)
  const childRecord = h.mounting.mountOf(child)
  assert.ok(childRecord)
  assert.equal(childRecord.lease, parentRecord.lease)
  assert.equal(childRecord.map.remoteRoot, '/srv/app')
  assert.equal(m.leases.size, 1)
  assert.deepEqual(opened, ['solo'])
  assert.equal(h.mounting.blockReason(child), undefined)

  // The child may take the GUI of the shared lease; ending the child keeps the parent's mount.
  await h.call(child, 'env_borrow', { environment: 'solo', gui: true })
  assert.deepEqual([...parentRecord.lease.guiUsers], ['c'])
  await h.mounting.uninstall(child)
  await tick()
  assert.equal(parentRecord.lease.released, false)
  assert.equal(parentRecord.lease.mode, 'headless')

  // Re-mounted on its next step; then the parent's mount is lost and the child is blocked.
  assert.deepEqual(await h.preStep(child), { kind: 'enter', messages: [] })
  m.open = () => Promise.reject(new Error('host unreachable'))
  parentRecord.env.emit('close', undefined)
  await tick()
  assert.equal(h.mounting.mountOf(child), undefined)
  assert.match(h.mounting.blockReason(child) ?? '', /环境 Solo 挂载失败/)
  await assert.rejects(h.preStep(child), (e: unknown) => e instanceof MountBlockedError)
  await cleanup()
})

test('a subagent of an unmounted session runs on the host', async () => {
  const { m, cleanup } = manager()
  const h = host(m)
  const parent = h.agent('p', os.tmpdir())
  await h.created(parent)
  const child = h.agent('c', os.tmpdir(), 'p')
  m.setSessionSettings('c', { mount: { envId: 'phone' } })
  await h.created(child)
  assert.equal(h.mounting.mountOf(child), undefined, 'subagents follow their parent, not their own settings')
  assert.equal(h.mounting.blockReason(child), undefined)
  await cleanup()
})
