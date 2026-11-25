import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EnvError } from '@dsh-environments/protocol'
import type { ServerEnvironment } from '../src/env/server/server-env.ts'
import {
  accountSessions,
  attachSharedSession,
  dropSessionRecord,
  readSessionRecord,
  recordIsFresh,
  sessionRecordPath,
  touchSessionRecord,
  writeSessionRecord,
  type SessionRecord,
} from '../src/env/winuser/session-share.ts'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-share-'))
}

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return { account: 'dsh-test1', port: 7400, token: 'tok', startedAt: 1000, verifiedAt: 1000, ...over }
}

/** A stand-in for the environment a connection would return. */
const env = { id: 'win', closed: false } as unknown as ServerEnvironment

test('a session record survives a round trip and rejects incomplete files', () => {
  const dir = tempDir()
  try {
    assert.equal(readSessionRecord(dir, 'dsh-test1'), undefined, 'no record yet')
    writeSessionRecord(dir, record({ pid: 42 }))
    assert.deepEqual(readSessionRecord(dir, 'dsh-test1'), record({ pid: 42 }))
    assert.equal(path.basename(sessionRecordPath(dir, 'DsH-Test1')), 'dsh-test1.session.json')

    for (const bad of ['not json', '{}', '{"port":"x","token":"t","startedAt":1}', '{"port":7400,"token":""}']) {
      fs.writeFileSync(sessionRecordPath(dir, 'dsh-test1'), bad)
      assert.equal(readSessionRecord(dir, 'dsh-test1'), undefined, bad)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a record is only aged out by its own last sighting', () => {
  assert.equal(recordIsFresh(record({ startedAt: 0, verifiedAt: 0 }), 1000, 5000), true)
  assert.equal(recordIsFresh(record({ startedAt: 0, verifiedAt: 0 }), 6000, 5000), false)
  // A borrower that reached the server keeps the record young even while the logon is long past.
  assert.equal(recordIsFresh(record({ startedAt: 0, verifiedAt: 5000 }), 9000, 5000), true)
})

test('dropping a record leaves a newer one (another borrower’s session) alone', () => {
  const dir = tempDir()
  try {
    writeSessionRecord(dir, record())
    const mine = readSessionRecord(dir, 'dsh-test1')
    assert.ok(mine)
    writeSessionRecord(dir, record({ port: 7401, token: 'other' }))
    assert.equal(dropSessionRecord(dir, 'dsh-test1', mine), false, 'the record was replaced meanwhile')
    assert.equal(readSessionRecord(dir, 'dsh-test1')?.port, 7401)
    assert.equal(dropSessionRecord(dir, 'dsh-test1', record({ port: 7401, token: 'other' })), true)
    assert.equal(readSessionRecord(dir, 'dsh-test1'), undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sessions of an account ignore the listener but keep disconnected ones', () => {
  const probe = {
    sessions: [
      { id: 0, name: 'Services', user: '', state: 'disconnected' },
      { id: 1, name: 'Console', user: 'someone', state: 'active' },
      { id: 2, name: 'RDP-Tcp#7', user: 'DSH-Test1', state: 'active' },
      { id: 3, name: 'RDP-Tcp', user: 'dsh-test1', state: 'listener' },
      { id: 4, name: 'RDP-Tcp#9', user: 'dsh-test1', state: 'disconnected' },
    ],
  }
  assert.deepEqual(accountSessions(probe, 'dsh-test1'), [2, 4], 'a disconnected session still swallows a logon')
  assert.deepEqual(accountSessions(probe, 'nobody'), [])
  assert.deepEqual(accountSessions(undefined, 'dsh-test1'), [])
})

/** Drive `attachSharedSession` with a fake clock, connectors and session table. */
async function attach(
  dir: string,
  options: {
    connect: (record: SessionRecord, calls: number) => Promise<ServerEnvironment>
    hasSession?: boolean | undefined
    now?: { value: number }
    startupMs?: number
    signal?: AbortSignal
    onSleep?: () => void
  },
): Promise<{
  env: ServerEnvironment | undefined
  calls: number
  sleeps: number
  hasSessionCalls: number
  log: string[]
}> {
  const state = { calls: 0, sleeps: 0, hasSessionCalls: 0 }
  const log: string[] = []
  const clock = options.now ?? { value: 2000 }
  const result = await attachSharedSession({
    dataDir: dir,
    account: 'dsh-test1',
    connect: async r => {
      state.calls++
      return await options.connect(r, state.calls)
    },
    hasSession: async () => {
      state.hasSessionCalls++
      return options.hasSession
    },
    signal: options.signal,
    now: () => clock.value,
    sleep: async ms => {
      state.sleeps++
      clock.value += ms
      options.onSleep?.()
    },
    startupMs: options.startupMs ?? 5000,
    log: message => log.push(message),
  })
  return { env: result, ...state, log }
}

test('a record whose server answers is shared, and marked as seen', async () => {
  const dir = tempDir()
  try {
    writeSessionRecord(dir, record({ startedAt: 0, verifiedAt: 0 }))
    const r = await attach(dir, { connect: async () => env })
    assert.equal(r.env, env, 'the running session is joined, not logged in again')
    assert.equal(r.calls, 1)
    assert.equal(r.sleeps, 0)
    assert.equal(readSessionRecord(dir, 'dsh-test1')?.verifiedAt, 2000, 'the record stays young for others')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a record whose port belongs to something else is dropped, without waiting', async () => {
  const dir = tempDir()
  try {
    writeSessionRecord(dir, record())
    const r = await attach(dir, {
      connect: async () => {
        throw new EnvError('AUTH', 'wrong secret')
      },
    })
    assert.equal(r.env, undefined)
    assert.equal(r.calls, 1, 'a wrong token means the record is stale, not that a logon is coming')
    assert.equal(r.sleeps, 0)
    assert.equal(readSessionRecord(dir, 'dsh-test1'), undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a fresh record with no session behind it is dropped at once', async () => {
  const dir = tempDir()
  try {
    writeSessionRecord(dir, record({ startedAt: 2000, verifiedAt: 2000 }))
    const r = await attach(dir, {
      connect: async () => {
        throw new EnvError('ECONNREFUSED', 'nothing listening')
      },
      hasSession: false,
    })
    assert.equal(r.env, undefined)
    assert.equal(r.sleeps, 0, 'a session that is gone is never waited for')
    assert.equal(r.hasSessionCalls, 1)
    assert.equal(readSessionRecord(dir, 'dsh-test1'), undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a fresh record is waited for while the account has a session', async () => {
  const dir = tempDir()
  try {
    writeSessionRecord(dir, record({ startedAt: 2000, verifiedAt: 2000 }))
    const r = await attach(dir, {
      connect: async (_record, calls) => {
        if (calls < 3) throw new EnvError('ECONNREFUSED', 'the logon is still coming up')
        return env
      },
      hasSession: true,
    })
    assert.equal(r.env, env, 'the logon in flight is waited for, then joined')
    assert.equal(r.calls, 3)
    assert.equal(r.sleeps, 2)
    assert.ok(
      r.log.some(line => line.includes('waiting for the session server')),
      r.log.join('; '),
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a stale record is dropped without waiting for anything', async () => {
  const dir = tempDir()
  try {
    writeSessionRecord(dir, record({ startedAt: 0, verifiedAt: 0 }))
    const r = await attach(dir, {
      connect: async () => {
        throw new EnvError('ECONNREFUSED', 'nothing listening')
      },
      hasSession: true,
      // The record is older than the window a logon is allowed to take: nothing is coming.
      startupMs: 1000,
    })
    assert.equal(r.env, undefined)
    assert.equal(r.calls, 1)
    assert.equal(r.sleeps, 0)
    assert.equal(r.hasSessionCalls, 0, 'an aged-out record needs no session probe')
    assert.equal(readSessionRecord(dir, 'dsh-test1'), undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a cancelled borrow leaves the record of the session that was coming up', async () => {
  const dir = tempDir()
  try {
    writeSessionRecord(dir, record({ startedAt: 2000, verifiedAt: 2000 }))
    const controller = new AbortController()
    const r = await attach(dir, {
      connect: async () => {
        throw new EnvError('ECONNREFUSED', 'the logon is still coming up')
      },
      hasSession: true,
      signal: controller.signal,
      onSleep: () => controller.abort(),
    })
    assert.equal(r.env, undefined)
    assert.equal(r.sleeps, 1)
    assert.ok(readSessionRecord(dir, 'dsh-test1'), 'the other borrower’s session must not be written off')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('without a record nothing is dialled at all', async () => {
  const dir = tempDir()
  try {
    const r = await attach(dir, { connect: async () => env })
    assert.equal(r.env, undefined)
    assert.equal(r.calls, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('touching a record of a vanished account is not fatal', () => {
  const dir = tempDir()
  try {
    const r = touchSessionRecord(dir, record(), 12345)
    assert.equal(r.verifiedAt, 12345)
    assert.equal(readSessionRecord(dir, 'dsh-test1')?.verifiedAt, 12345)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
