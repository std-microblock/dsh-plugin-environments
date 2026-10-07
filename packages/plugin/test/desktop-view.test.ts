// The live desktop viewer's host action, exercised against a real environment server.
//
// `desktop.frame` is the only thing the GUI polls while the viewer is open, so this covers the
// whole preview chain: action → cached browse connection → environment → `sys.screenshot` →
// downscale → base64. The private-desktop rendering itself is covered by the Rust tests
// (`screen::private_desktop_tests`).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createActions } from '../src/api/actions.ts'
import type { PluginContext } from '../src/host-api.ts'
import { EnvironmentManager } from '../src/manager/manager.ts'
import { needsServer } from './helpers.ts'

/** Actions only need the manager for this path; the rest is stubbed. */
function actionsFor(manager: EnvironmentManager, dataDir: string) {
  return createActions({ get: () => undefined } as unknown as PluginContext, manager, {
    mounting: {} as never,
    borrowing: {} as never,
    mountsDir: dataDir,
  })
}

test('desktop.frame rejects an unknown environment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-'))
  const manager = new EnvironmentManager({ dataDir: dir, autoDiscoverAdb: false })
  manager.load()
  const actions = actionsFor(manager, dir)
  await assert.rejects(() => actions['desktop.frame']!({ envId: 'nope' }), /ENOENT|unknown/)
})

// Screenshots need a Windows server; on other platforms the environment has no such capability.
const skipUnlessWindows = process.platform === 'win32' ? {} : { skip: 'needs a Windows server' }

test('a session-mode account is never started just to take a screenshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-'))
  const manager = new EnvironmentManager({ dataDir: dir, autoDiscoverAdb: false })
  manager.load()
  const def = manager.upsert({
    id: 'win_x',
    name: 'Session account',
    kind: 'winuser',
    config: { account: 'x', desktop: 'session' },
  })
  assert.equal(def.config.desktop, 'session')
  const actions = actionsFor(manager, dir)
  await assert.rejects(
    () => actions['desktop.frame']!({ envId: 'win_x' }),
    /no session running/,
    'without a lease the viewer must ask for a session, not create a second one',
  )
})

test('desktop.frame prefers the live lease over opening another connection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-'))
  const manager = new EnvironmentManager({ dataDir: dir, autoDiscoverAdb: false })
  manager.load()
  manager.upsert({
    id: 'win_y',
    name: 'Leased account',
    kind: 'winuser',
    config: { account: 'y', desktop: 'session' },
  })
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  let captured = 0
  const fake = {
    name: 'fake',
    closed: false,
    hasCap: (cap: string) => cap === 'screenshot',
    capture: async () => {
      captured++
      return { png, width: 64, height: 32, rect: { x: 0, y: 0, width: 64, height: 32 } }
    },
    desktopName: 'session:y',
  }
  manager.leases.set('lease1', { envId: 'win_y', env: fake } as unknown as never)
  const actions = actionsFor(manager, dir)
  const frame = (await actions['desktop.frame']!({ envId: 'win_y' })) as {
    mime: string
    data: string
    desktop: string | null
  }
  assert.equal(captured, 1, 'the lease connection was used')
  assert.equal(frame.mime, 'image/png')
  assert.equal(frame.desktop, 'session:y')
  assert.equal(frame.data, png.toString('base64'))
})

test('desktop.frame returns one PNG frame of the local desktop', { ...needsServer, ...skipUnlessWindows }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-'))
  const manager = new EnvironmentManager({ dataDir: dir, autoDiscoverAdb: false })
  manager.load()
  const actions = actionsFor(manager, dir)
  const frame = (await actions['desktop.frame']!({ envId: 'local', maxWidth: 640 })) as {
    mime: string
    data: string
    width: number
    height: number
    desktop: string | null
  }
  assert.equal(frame.mime, 'image/png')
  assert.ok(frame.width > 0 && frame.height > 0, `unexpected size ${frame.width}x${frame.height}`)
  assert.ok(frame.width <= 640, 'the frame is downscaled to the requested width')
  const png = Buffer.from(frame.data, 'base64')
  assert.ok(png.length > 1000, `frame looks empty (${png.length} bytes)`)
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG', 'payload is a PNG')
  // The local environment runs on the human's desktop, so it has no private desktop name.
  assert.equal(frame.desktop, null)
  await manager.dispose()
})
