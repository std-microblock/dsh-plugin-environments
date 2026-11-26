import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionBlocked, derivedWorkspaceTitle, pathBarIntent } from '../src/browser-logic.ts'

test('an unsubmitted path in the path bar wins over the loaded directory', () => {
  assert.deepEqual(pathBarIntent({ pathText: '/data/shared', currentDir: '/home/dev' }), { load: '/data/shared' })
})

test('the loaded directory is reused when the path bar still shows it', () => {
  assert.deepEqual(pathBarIntent({ pathText: ' /home/dev ', currentDir: '/home/dev' }), { path: '/home/dev' })
})

test('an empty path bar falls back to the loaded directory, and yields nothing without one', () => {
  assert.deepEqual(pathBarIntent({ pathText: '   ', currentDir: '/home/dev' }), { path: '/home/dev' })
  assert.deepEqual(pathBarIntent({ pathText: '', currentDir: undefined }), {})
})

test('create / choose is enabled for a typed path, but not while a request runs', () => {
  const typed = { pathText: '/data/shared', currentDir: '/home/dev' }
  assert.equal(actionBlocked({ ...typed, busy: false, loading: false }), false)
  assert.equal(actionBlocked({ ...typed, busy: false, loading: true }), true)
  assert.equal(actionBlocked({ ...typed, busy: true, loading: false }), true)
  assert.equal(actionBlocked({ pathText: '', currentDir: undefined, busy: false, loading: false }), true)
})

test('the title preview follows the directory and the environment', () => {
  assert.equal(derivedWorkspaceTitle('/nfs/prod/dev-cpu', 'dev_hg'), 'dev-cpu @ dev_hg')
  assert.equal(derivedWorkspaceTitle('C:\\work\\repo\\', 'win'), 'repo @ win')
  assert.equal(derivedWorkspaceTitle(undefined, 'win'), '')
})
