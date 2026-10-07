import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionChecks, sessionPhase, type SessionStatusView } from '../src/session-logic.ts'

const HOME_MISSING = [
  'termwrap-missing',
  'rdp-disabled',
  'rfxvmt-missing',
  'rd-users-group-missing',
  'term-service-stopped',
  'listener-down',
]

function status(over: Partial<SessionStatusView> = {}): SessionStatusView {
  return {
    ok: true,
    ready: false,
    missing: HOME_MISSING,
    reasons: HOME_MISSING.map(k => `reason ${k}`),
    editionKind: 'home',
    needsTermWrap: true,
    termsrv: { version: '10.0.26100.9444', wrapperInstalled: false },
    termwrap: { present: true, version: '1.0', license: 'MIT', files: ['a', 'b'] },
    ...over,
  }
}

test('a fresh Home machine offers the bundled TermWrap install', () => {
  assert.equal(sessionPhase(status()), 'install')
})

test('without a bundled payload the install is manual', () => {
  assert.equal(
    sessionPhase(status({ termwrap: { present: false, version: null, license: null, files: [] } })),
    'manual',
  )
})

test('an installed wrapper waits for a reboot, also right after installing', () => {
  assert.equal(sessionPhase(status({ termsrv: { version: null, wrapperInstalled: true } })), 'reboot')
  assert.equal(sessionPhase(status(), true), 'reboot')
})

test('a Server SKU only needs the RDP host and never lists TermWrap', () => {
  const s = status({
    editionKind: 'server',
    needsTermWrap: false,
    missing: ['rdp-disabled'],
    reasons: ['rdp off'],
  })
  assert.equal(sessionPhase(s), 'enable')
  const checks = sessionChecks(s)
  assert.ok(!checks.some(c => c.id === 'termwrap'))
  assert.deepEqual(
    checks.filter(c => !c.ok).map(c => [c.id, c.reason]),
    [['rdp', 'rdp off']],
  )
})

test('ready wins, and non-Windows hosts are unsupported', () => {
  assert.equal(sessionPhase(status({ ready: true, missing: [], reasons: [] })), 'ready')
  assert.equal(sessionPhase(status({ missing: ['not-windows'], reasons: ['x'] })), 'unsupported')
})

test('checks keep the server reason of every failed prerequisite', () => {
  const checks = sessionChecks(status())
  assert.equal(checks.length, 6)
  assert.ok(checks.every(c => !c.ok && c.reason?.startsWith('reason ')))
})
