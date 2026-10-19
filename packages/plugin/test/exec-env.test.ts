import assert from 'node:assert/strict'
import test from 'node:test'
import { ExecEnvRegistry, installExecEnv } from '../src/env/exec-env.ts'
import type { Agent, PluginContext } from '../src/host-api.ts'

/** A context double that runs effects immediately and hands back their disposers. */
function context(): PluginContext {
  const disposers: (() => unknown)[] = []
  const ctx = {
    effect: (fn: () => () => unknown) => {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    provide: () => () => {},
  }
  return Object.assign(ctx, { disposeAll: () => disposers.splice(0).forEach(dispose => dispose()) }) as unknown as PluginContext
}

function agent(id: string, cwd = '/work'): Agent {
  return { ctx: context(), session: { id, header: { cwd } } }
}

const variables = (names: string[]) =>
  Object.fromEntries(names.map(name => [name, { description: `fact ${name}` }]))

test('exec env: declared values reach the command overlay', () => {
  const registry = new ExecEnvRegistry(context())
  registry.register({
    name: 'toc',
    variables: variables(['FORGE_AGENT_CHAT_ID', 'FORGE_AGENT_THREAD_ID']),
    resolve: current => (current ? { FORGE_AGENT_CHAT_ID: `oc_${current.session.id}`, FORGE_AGENT_THREAD_ID: 'omt_1' } : {}),
  })

  assert.deepEqual(registry.collect(agent('im-1')), {
    FORGE_AGENT_CHAT_ID: 'oc_im-1',
    FORGE_AGENT_THREAD_ID: 'omt_1',
  })
  // No agent: the contributor's resolver still runs and may supply nothing.
  assert.deepEqual(registry.collect(undefined), {})
})

test('exec env: an undefined value leaves the environment variable alone', () => {
  const registry = new ExecEnvRegistry(context())
  registry.register({
    name: 'partial',
    variables: variables(['A_SET', 'B_UNSET']),
    resolve: () => ({ A_SET: 'yes', B_UNSET: undefined }),
  })
  assert.deepEqual(registry.collect(undefined), { A_SET: 'yes' })
})

test('exec env: list enumerates declared names in name order', () => {
  const registry = new ExecEnvRegistry(context())
  registry.register({ name: 'beta', variables: variables(['ZED']), resolve: () => ({}) })
  registry.register({ name: 'alpha', variables: variables(['ALPHA', 'MIKE']), resolve: () => ({}) })
  assert.deepEqual(
    registry.list().map(entry => [entry.name, entry.contributor]),
    [
      ['ALPHA', 'alpha'],
      ['MIKE', 'alpha'],
      ['ZED', 'beta'],
    ],
  )
})

test('exec env: invalid declarations fail at registration', () => {
  const registry = new ExecEnvRegistry(context())
  assert.throws(() => registry.register({ name: ' ', variables: {}, resolve: () => ({}) }), /non-empty/)
  assert.throws(
    () => registry.register({ name: 'bad', variables: { '1NOPE': { description: 'x' } }, resolve: () => ({}) }),
    /invalid name/,
  )
  assert.throws(
    () => registry.register({ name: 'silent', variables: { OK_NAME: { description: '  ' } }, resolve: () => ({}) }),
    /must describe/,
  )

  registry.register({ name: 'first', variables: variables(['ONLY_ONE']), resolve: () => ({}) })
  assert.throws(
    () => registry.register({ name: 'second', variables: variables(['ONLY_ONE']), resolve: () => ({}) }),
    /already owned/,
  )
  assert.throws(
    () => registry.register({ name: 'first', variables: variables(['OTHER']), resolve: () => ({}) }),
    /already registered/,
  )
})

test('exec env: undeclared and non-string results are rejected', () => {
  const registry = new ExecEnvRegistry(context())
  registry.register({
    name: 'liar',
    variables: variables(['DECLARED']),
    resolve: () => ({ DECLARED: 'ok', UNDECLARED: 'nope' }),
  })
  assert.throws(() => registry.collect(undefined), /undeclared name "UNDECLARED"/)

  const numeric = new ExecEnvRegistry(context())
  numeric.register({
    name: 'numeric',
    variables: variables(['DECLARED']),
    resolve: () => ({ DECLARED: 1 as unknown as string }),
  })
  assert.throws(() => numeric.collect(undefined), /non-string value/)
})

test('exec env: disposing the registering fiber removes the variables', () => {
  const ctx = context() as PluginContext & { disposeAll(): void }
  const registry = new ExecEnvRegistry(ctx)
  registry.register({ name: 'toc', variables: variables(['FORGE_AGENT_CHAT_ID']), resolve: () => ({ FORGE_AGENT_CHAT_ID: 'oc_1' }) })
  assert.equal(registry.collect(undefined)['FORGE_AGENT_CHAT_ID'], 'oc_1')

  ctx.disposeAll()
  assert.deepEqual(registry.collect(undefined), {})
  assert.deepEqual(registry.list(), [])
  // The name and the variable are free again once the owner is gone.
  registry.register({ name: 'toc', variables: variables(['FORGE_AGENT_CHAT_ID']), resolve: () => ({ FORGE_AGENT_CHAT_ID: 'oc_2' }) })
  assert.equal(registry.collect(undefined)['FORGE_AGENT_CHAT_ID'], 'oc_2')
})

test('exec env: install publishes the registry as a provided service', () => {
  const provided: [string, unknown][] = []
  const ctx = {
    effect: (fn: () => () => unknown) => fn(),
    provide: (name: string, value: unknown) => {
      provided.push([name, value])
      return () => {}
    },
  } as unknown as PluginContext
  const registry = installExecEnv(ctx)
  assert.equal(provided[0]?.[0], 'execEnv')
  assert.equal(provided[0]?.[1], registry)
})
