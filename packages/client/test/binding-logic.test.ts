/// <reference types="node" />
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bindingsById,
  bindingsFromState,
  isUnavailable,
  pathKey,
  workspaceIdOfRowKey,
  workspacesKey,
} from '../src/binding-logic.ts'
import type { EnvView, StateView } from '../src/types.ts'

const env = (id: string, kind: EnvView['kind'], extra: Partial<EnvView> = {}): EnvView => ({
  id,
  name: id.toUpperCase(),
  kind,
  alias: id,
  exclusive: false,
  config: {},
  ...extra,
})

test('sidebar row keys', () => {
  assert.equal(workspaceIdOfRowKey('workspace:abc'), 'abc')
  assert.equal(workspaceIdOfRowKey('workspace:'), undefined, 'the ungrouped bucket')
  assert.equal(workspaceIdOfRowKey('session:abc'), undefined)
  assert.equal(workspaceIdOfRowKey(null), undefined)
})

test('path keys compare Windows paths loosely', () => {
  assert.equal(pathKey('C:\\Users\\Me\\.dsh\\env-mounts\\x\\'), 'c:/users/me/.dsh/env-mounts/x')
  assert.equal(pathKey('/Home/me/'), '/Home/me')
  assert.equal(pathKey(undefined), '')
})

test('red dot states', () => {
  assert.equal(isUnavailable('offline'), true)
  assert.equal(isUnavailable('error'), true)
  assert.equal(isUnavailable('available'), false)
  assert.equal(isUnavailable('busy'), false)
  assert.equal(isUnavailable(undefined), false)
})

test('fallback bindings from the state of an older host plugin', () => {
  const state: StateView = {
    platform: 'win32',
    environments: [
      env('local', 'local'),
      env('pixel', 'adb', { config: { serial: 'PX1' } }),
      env('tab', 'adb', { config: { serial: 'TB1' } }),
      env('box', 'server', { status: { busy: true } }),
    ],
    discovered: { adb: [{ serial: 'PX1', state: 'device' }] },
    remoteWorkspaces: [
      { id: 'r1', envId: 'pixel', root: '/sdcard', title: 'sd', hostPath: 'C:\\m\\a', workspaceId: 'w1' },
      { id: 'r2', envId: 'tab', root: '/data', title: 'data', hostPath: 'C:\\m\\b' },
      { id: 'r3', envId: 'box', root: '/srv', title: 'srv', hostPath: 'C:\\m\\c', workspaceId: 'w3' },
      { id: 'r4', envId: 'gone', root: '/', title: 'gone', hostPath: 'C:\\m\\d', workspaceId: 'w4' },
    ],
    leases: [],
  }
  const view = bindingsFromState(state, [
    { workspaceId: 'w1' },
    { workspaceId: 'w2', path: 'c:/M/B' },
    { workspaceId: 'w3' },
    { workspaceId: 'w4' },
    { workspaceId: 'plain', path: 'C:\\code' },
  ])
  assert.deepEqual(
    view.bindings.map(b => [b.workspaceId, b.kind, b.envId]),
    [
      ['w1', 'remote', 'pixel'],
      ['w2', 'remote', 'tab'],
      ['w3', 'remote', 'box'],
      ['w4', 'remote', 'gone'],
    ],
  )
  assert.equal(view.availability['pixel']?.state, 'available')
  assert.equal(view.availability['tab']?.state, 'offline')
  assert.equal(view.availability['box']?.state, 'busy')
  assert.equal(view.availability['gone']?.state, 'error')
  assert.deepEqual(
    view.environments.map(e => e.id),
    ['pixel', 'tab', 'box'],
  )
  assert.equal(bindingsById(view).get('w2')?.remoteRoot, '/data')
})

test('workspace list identity', () => {
  assert.equal(workspacesKey([{ workspaceId: 'a', path: '/a' }]), workspacesKey([{ workspaceId: 'a', path: '/a' }]))
  assert.notEqual(workspacesKey([{ workspaceId: 'a' }]), workspacesKey([{ workspaceId: 'a', path: '/a' }]))
})
