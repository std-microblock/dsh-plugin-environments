import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { sharedBinary } from '../src/env/winuser/winuser-env.ts'

test('sharedBinary copies by content hash and replaces tampered or old copies', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shared-bin-'))
  try {
    const src = path.join(tmp, 'src.exe')
    fs.writeFileSync(src, 'binary v1')
    const base = path.join(tmp, 'ProgramData')
    const a = sharedBinary(src, base)
    assert.equal(path.dirname(a), path.join(base, 'dsh-env'))
    assert.match(path.basename(a), /^dsh-env-server-[0-9a-f]{16}\.exe$/)
    assert.equal(fs.readFileSync(a, 'utf8'), 'binary v1')
    assert.equal(sharedBinary(src, base), a)

    fs.writeFileSync(a, 'tampered')
    assert.equal(sharedBinary(src, base), a)
    assert.equal(fs.readFileSync(a, 'utf8'), 'binary v1')

    fs.writeFileSync(src, 'binary v2')
    const b = sharedBinary(src, base)
    assert.notEqual(b, a)
    assert.equal(fs.existsSync(a), false, 'old version removed')
    assert.deepEqual(fs.readdirSync(path.dirname(b)), [path.basename(b)])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
