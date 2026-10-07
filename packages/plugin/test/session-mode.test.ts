// Session-mode helpers: the TermWrap payload description and the live capability probe.
//
// TermWrap needs no per-build table — it finds the patch offsets in the loaded `termsrv.dll`
// itself — so the payload is just files plus their hashes, and the probe reports whether a
// wrapper is installed at all.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { probeSession, termwrapDir, termwrapPayload } from '../src/env/winuser/session-mode.ts'
import { createActions } from '../src/api/actions.ts'
import type { PluginContext } from '../src/host-api.ts'
import { EnvironmentManager } from '../src/manager/manager.ts'
import { needsServer } from './helpers.ts'

test('a missing payload is reported, not thrown', () => {
  const payload = termwrapPayload(path.join(os.tmpdir(), 'dsh-termwrap-does-not-exist'))
  assert.equal(payload.present, false)
  assert.deepEqual(payload.files, [])
  assert.equal(payload.license, false)
  assert.equal(payload.version, null)
})

test('a staged payload reports its files, licence and version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-termwrap-'))
  try {
    fs.writeFileSync(path.join(dir, 'TermWrap.dll'), 'not a real dll')
    fs.writeFileSync(path.join(dir, 'UmWrap.dll'), 'neither is this')
    fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT License')
    fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0\n')
    const payload = termwrapPayload(dir)
    assert.equal(payload.present, true)
    assert.equal(payload.version, '1.0.0')
    assert.equal(payload.license, true)
    assert.deepEqual(payload.files.map(f => f.name).sort(), ['TermWrap.dll', 'UmWrap.dll'])
    const dll = payload.files.find(f => f.name === 'TermWrap.dll')!
    assert.equal(dll.bytes, 'not a real dll'.length)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the packaged payload directory is inside the plugin package', () => {
  assert.match(termwrapDir().replace(/\\/g, '/'), /packages\/plugin\/vendor\/termwrap$/)
})

// The probe reads real registry/service/session state, so it needs a Windows host and the
// built server binary.
const skipUnlessWindows = process.platform === 'win32' ? {} : { skip: 'needs a Windows host' }

test('session.status probes the real machine', { ...needsServer, ...skipUnlessWindows }, async () => {
  const probe = await probeSession()
  assert.equal(probe.ok, true)
  assert.ok(Array.isArray(probe.missing))
  assert.equal(probe.ready, probe.missing.length === 0, 'ready must agree with missing')
  // The version the wrapper matches on: `10.0.<build>.<revision>`.
  assert.match(probe.termsrv.version ?? '', /^10\.0\.\d+\.\d+$/)
  assert.equal(typeof probe.termsrv.wrapperInstalled, 'boolean')
  assert.ok(probe.sessions.length > 0, 'the probe session must be listed')
  assert.ok(probe.rdp.port > 0)
})

test('the session.status action adds the payload description', { ...needsServer, ...skipUnlessWindows }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-'))
  const manager = new EnvironmentManager({ dataDir: dir, autoDiscoverAdb: false })
  manager.load()
  const actions = createActions({ get: () => undefined } as unknown as PluginContext, manager, {
    mounting: {} as never,
    borrowing: {} as never,
    mountsDir: dir,
  })
  const status = (await actions['session.status']!({})) as {
    ready: boolean
    missing: string[]
    termsrv: { version: string | null }
    termwrap: { present: boolean; files: unknown[] }
  }
  assert.equal(typeof status.ready, 'boolean')
  assert.ok(Array.isArray(status.missing))
  assert.ok(status.termsrv.version)
  // A source checkout has no staged payload unless `pnpm run fetch:termwrap` was run; either way
  // the shape must be there so the UI can decide between "install" and "install it manually".
  assert.equal(typeof status.termwrap.present, 'boolean')
  assert.ok(Array.isArray(status.termwrap.files))
  await manager.dispose()
})
