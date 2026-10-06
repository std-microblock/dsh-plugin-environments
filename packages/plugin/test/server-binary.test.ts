// Locating shipped server binaries, raw or Brotli-compressed as in release packages.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'
import { SERVER_TARGETS as SCRIPT_TARGETS } from '../../../scripts/server-targets.ts'
import { serverBinary } from '../src/env/server/connect.ts'
import {
  HOST_TARGET,
  hasServerBinary,
  SERVER_TARGETS,
  serverBinaryBytes,
  serverBinaryFile,
  serverExeName,
  targetForHost,
} from '../src/server-binary.ts'
import { needsServer } from './helpers.ts'

const ENV_KEYS = ['DSH_ENV_SERVER_BIN', 'DSH_ENV_SERVER_BIN_DIR', 'DSH_HOME'] as const

/** Run `fn` with the given environment overrides, restoring the previous values afterwards. */
function withEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void): void {
  const saved = ENV_KEYS.map(k => [k, process.env[k]] as const)
  try {
    for (const k of ENV_KEYS) {
      const v = env[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test('build scripts and plugin agree on the shipped targets', () => {
  assert.deepEqual(
    SCRIPT_TARGETS.map(t => t.target),
    [...SERVER_TARGETS],
  )
  for (const t of SCRIPT_TARGETS) assert.equal(t.exe, serverExeName(t.target))
})

test('targetForHost maps uname / Windows reports', () => {
  assert.equal(targetForHost('Linux', 'x86_64'), 'linux-x64')
  assert.equal(targetForHost('Linux', 'i686'), 'linux-ia32')
  assert.equal(targetForHost('Linux', 'aarch64'), 'linux-arm64')
  assert.equal(targetForHost('Darwin', 'arm64'), 'darwin-arm64')
  assert.equal(targetForHost('Windows_NT', 'AMD64'), 'win32-x64')
  assert.equal(targetForHost('Darwin', 'x86_64'), undefined)
  assert.equal(targetForHost('FreeBSD', 'amd64'), undefined)
})

test('a missing target is reported, not guessed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-env-bin-empty-'))
  withEnv({ DSH_ENV_SERVER_BIN_DIR: root }, () => {
    assert.equal(hasServerBinary('linux-ia32'), false)
    assert.equal(serverBinaryBytes('linux-ia32'), undefined)
    assert.throws(() => serverBinaryFile('linux-ia32'), /not found/)
  })
})

test('brotli-compressed binaries resolve and run', needsServer, () => {
  const source = serverBinary()
  const raw = fs.readFileSync(source)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-env-bin-br-'))
  const root = path.join(tmp, 'bin')
  const br = zlib.brotliCompressSync(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC,
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  })
  for (const target of [HOST_TARGET, 'linux-arm64']) {
    fs.mkdirSync(path.join(root, target), { recursive: true })
    fs.writeFileSync(path.join(root, target, `${serverExeName(target)}.br`), br)
  }

  withEnv({ DSH_ENV_SERVER_BIN_DIR: root, DSH_HOME: path.join(tmp, 'home') }, () => {
    assert.ok(hasServerBinary(HOST_TARGET))
    assert.ok(raw.equals(serverBinaryBytes('linux-arm64') ?? Buffer.alloc(0)))
    assert.ok(raw.equals(serverBinaryBytes() ?? Buffer.alloc(0)))

    const file = serverBinaryFile()
    assert.ok(file.startsWith(path.join(tmp, 'home', 'cache')), file)
    assert.equal(path.basename(file), serverExeName())
    assert.ok(raw.equals(fs.readFileSync(file)))
    const out = execFileSync(file, ['--version'], { encoding: 'utf8' })
    assert.match(out, /^dsh-env-server \d+\.\d+\.\d+/)

    // Second resolution reuses the unpacked copy.
    const mtime = fs.statSync(file).mtimeMs
    assert.equal(serverBinaryFile(), file)
    assert.equal(fs.statSync(file).mtimeMs, mtime)
  })
})
