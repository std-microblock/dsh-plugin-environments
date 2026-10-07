// The mount gate: a session whose mount failed (or was lost) runs no model step and no tool.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createActions } from '../src/api/actions.ts'
import type { Borrowing } from '../src/borrowing/index.ts'
import type { HarnessDeps } from '../src/deps.ts'
import type { Environment } from '../src/env/environment.ts'
import type {
  Agent,
  PluginContext,
  PreStepDecision,
  PreStepEvent,
  PreToolDecision,
  ToolPreExecution,
} from '../src/host-api.ts'
import { EnvironmentManager } from '../src/manager/manager.ts'
import { installMounting, MountBlockedError } from '../src/mount/index.ts'

type Listener = (...args: never[]) => unknown

/** A plugin context that records listeners and accepts every registration. */
function fakeContext() {
  const hooks = new Map<string, Listener[]>()
  const noop = () => () => {}
  const ctx = {
    on(name: string, listener: Listener) {
      hooks.set(name, [...(hooks.get(name) ?? []), listener])
      return () => {}
    },
    tools: { register: noop, restrict: noop, schemas: () => [] },
    systemPrompt: { getSectionOrder: () => 900, section: noop, variable: noop },
    logger: () => ({ info() {}, warn() {} }),
    effect: () => undefined,
    isolate: () => ctx,
    plugin: () => undefined,
    get: () => undefined,
  }
  const hook = (name: string): Listener => {
    const [listener] = hooks.get(name) ?? []
    assert.ok(listener, `listener for ${name}`)
    return listener
  }
  return {
    ctx: ctx as unknown as PluginContext,
    created: (agent: Agent) => (hook('agent/created') as (e: { agent: Agent }) => Promise<unknown>)({ agent }),
    preStep: (agent: Agent, signal = new AbortController().signal) => {
      const steps: number[] = []
      const run = (
        hook('agent/pre-step') as (e: PreStepEvent, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>
      )({ agent, turn: 1, step: 1, signal }, async () => {
        steps.push(1)
        return { kind: 'enter', messages: [] }
      })
      return { run, entered: () => steps.length > 0 }
    },
    preTool: (agent: Agent) =>
      (
        hook('tools/pre-execute') as (
          exec: ToolPreExecution,
          next: () => Promise<PreToolDecision>,
        ) => Promise<PreToolDecision>
      )({ agent, name: 'bash' }, async () => ({ kind: 'allow' })),
  }
}

class FakeBase {
  constructor(_ctx: unknown) {}
}

const fakeDeps = {
  defineTool: (definition: unknown) => definition,
  createScope: (ctx: PluginContext) => ({ ctx, dispose: async () => {} }),
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

/** A minimal POSIX environment with one directory, `/srv/app`. */
function fakeEnv(): Environment & EventEmitter {
  return Object.assign(new EventEmitter(), {
    name: 'Box',
    family: 'posix',
    info: { os: 'linux', cwd: '/srv/app', user: 'u', shell: '/bin/sh' },
    path: path.posix,
    resolvePath: (p: string, base?: string) => path.posix.resolve(base ?? '/', p),
    realpath: async (p: string) => p,
    stat: async (p: string) => (p === '/srv/app' ? { type: 'dir' } : null),
    readFile: async () => {
      throw new Error('ENOENT')
    },
    listTunnels: () => [],
    close: async () => {},
  }) as unknown as Environment & EventEmitter
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-env-gate-'))
  const m = new EnvironmentManager({ dataDir: dir, autoDiscoverAdb: false })
  m.load()
  m.upsert({ id: 'box', name: 'Box', kind: 'server', config: { host: 'box.lan', port: 7461 } })
  const ws = m.addRemoteWorkspace({ envId: 'box', root: '/srv/app', mountsDir: path.join(dir, 'mounts') })
  const opens: string[] = []
  let failure: string | undefined = 'connection refused'
  let env = fakeEnv()
  m.open = async def => {
    opens.push(def.id)
    if (failure) throw new Error(failure)
    env = fakeEnv()
    return env
  }
  const host = fakeContext()
  const mounting = installMounting(host.ctx, m, fakeDeps)
  const agent = (id: string, cwd: string): Agent => ({
    ctx: host.ctx,
    session: { id, header: { id, cwd } },
  })
  return {
    m,
    ws,
    host,
    mounting,
    agent,
    opens,
    env: () => env,
    setFailure: (f: string | undefined) => {
      failure = f
    },
    cleanup: async () => {
      await m.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10))

test('a failed mount blocks every step and tool call with the reason', async () => {
  const { m, ws, host, mounting, agent, opens, cleanup } = setup()
  const a = agent('s1', ws.hostPath)
  await host.created(a) // the failure is recorded, creation itself does not fail
  assert.equal(m.sessionSettings('s1').mountError, 'connection refused')
  assert.equal(mounting.mountOf(a), undefined)
  assert.equal(mounting.blockReason(a), '环境 Box 挂载失败：connection refused')

  const step = host.preStep(a)
  await assert.rejects(step.run, (e: unknown) => {
    assert.ok(e instanceof MountBlockedError)
    assert.equal(e.message, '环境 Box 挂载失败：connection refused')
    return true
  })
  assert.equal(step.entered(), false, 'the model step never runs')
  assert.equal(opens.length, 2, 'the step re-attempted the mount first')

  assert.deepEqual(await host.preTool(a), { kind: 'deny', reason: '环境 Box 挂载失败：connection refused' })
  await cleanup()
})

test('the next step mounts once the environment is back, and runs', async () => {
  const { m, ws, host, mounting, agent, setFailure, cleanup } = setup()
  const a = agent('s1', ws.hostPath)
  await host.created(a)
  assert.ok(mounting.blockReason(a))

  setFailure(undefined)
  const step = host.preStep(a)
  assert.deepEqual(await step.run, { kind: 'enter', messages: [] })
  assert.equal(step.entered(), true)
  assert.equal(mounting.mountOf(a)?.map.remoteRoot, '/srv/app')
  assert.equal(m.sessionSettings('s1').mountError, undefined, 'success clears the error')
  assert.equal(mounting.blockReason(a), undefined)
  assert.deepEqual(await host.preTool(a), { kind: 'allow' })
  await cleanup()
})

test('a lost mount blocks the session until it is remounted', async () => {
  const { m, ws, host, mounting, agent, env, setFailure, cleanup } = setup()
  setFailure(undefined)
  const a = agent('s1', ws.hostPath)
  await host.created(a)
  assert.ok(mounting.mountOf(a))

  env().emit('close')
  await settle()
  assert.equal(mounting.mountOf(a), undefined)
  assert.match(m.sessionSettings('s1').mountError ?? '', /connection lost/)
  assert.deepEqual(await host.preTool(a), {
    kind: 'deny',
    reason: '环境 Box 挂载失败：挂载已断开（connection lost）',
  })

  setFailure('host unreachable')
  await assert.rejects(host.preStep(a).run, /环境 Box 挂载失败：host unreachable/)
  setFailure(undefined)
  await host.preStep(a).run
  assert.ok(mounting.mountOf(a))
  await cleanup()
})

test('sessions without a mount are never gated', async () => {
  const { host, mounting, agent, opens, cleanup } = setup()
  const a = agent('plain', os.tmpdir())
  await host.created(a)
  assert.equal(mounting.blockReason(a), undefined)
  const step = host.preStep(a)
  await step.run
  assert.equal(step.entered(), true)
  assert.deepEqual(await host.preTool(a), { kind: 'allow' })
  assert.equal(opens.length, 0)
  await cleanup()
})

test('a cancelled turn does not wait for a slow remount', async () => {
  const { m, ws, host, agent, cleanup } = setup()
  const a = agent('s1', ws.hostPath)
  await host.created(a)
  let unblock: () => void = () => {}
  m.open = () =>
    new Promise((_resolve, reject) => {
      unblock = () => reject(new Error('timed out'))
    })
  const abort = new AbortController()
  const step = host.preStep(a, abort.signal)
  abort.abort(new Error('cancelled'))
  await assert.rejects(step.run, /cancelled/)
  unblock()
  await settle()
  await cleanup()
})

test('session.remount re-attempts the mount and reports the session state', async () => {
  const { m, ws, host, mounting, agent, setFailure, cleanup } = setup()
  const a = agent('s1', ws.hostPath)
  await host.created(a)
  const ctx = {
    get: (name: string) => (name === 'agents' ? { get: (id: string) => (id === 's1' ? a : undefined) } : undefined),
  } as unknown as PluginContext
  const actions = createActions(ctx, m, {
    mounting,
    borrowing: { heldOf: () => [] } as unknown as Borrowing,
    mountsDir: os.tmpdir(),
  })
  const remount = actions['session.remount']
  assert.ok(remount)
  const state = actions['state']
  assert.ok(state)

  const before = (await state({ sessionId: 's1' })) as { session: { mountBlocked?: string; mountError?: string } }
  assert.equal(before.session.mountBlocked, '环境 Box 挂载失败：connection refused')

  setFailure('still down')
  await assert.rejects(remount({ sessionId: 's1' }), /still down/)
  assert.equal(m.sessionSettings('s1').mountError, 'still down')

  setFailure(undefined)
  const after = (await remount({ sessionId: 's1' })) as {
    session: { mountBlocked?: string; mountError?: string; mountActive?: { envId: string } }
  }
  assert.equal(after.session.mountBlocked, undefined)
  assert.equal(after.session.mountError, undefined)
  assert.equal(after.session.mountActive?.envId, 'box')
  await assert.rejects(remount({ sessionId: 'gone' }), /not running/)
  await cleanup()
})
