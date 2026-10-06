import assert from 'node:assert/strict'
import test from 'node:test'
import { codePageLabel, decodeHostText } from '../src/env/host-process.ts'
import { Collector, incompleteUtf8Tail } from '../src/mount/subprocess-provider.ts'

const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) // "中文" in GBK

test('host output: UTF-8 lines kept, code-page lines decoded', () => {
  const gbkDecoder = () => new TextDecoder('gbk')
  assert.equal(decodeHostText(Buffer.from('中文 ok\n'), gbkDecoder), '中文 ok\n')
  const mixed = Buffer.concat([Buffer.from('{"ok":true,"name":"中"}\r\n'), gbk, Buffer.from('\r\n')])
  assert.equal(decodeHostText(mixed, gbkDecoder), '{"ok":true,"name":"中"}\r\n中文\r\n')
  assert.equal(codePageLabel(936), 'gbk')
  assert.equal(codePageLabel(1251), 'windows-1251')
  assert.equal(codePageLabel(437), 'windows-1252')
})

test('collector offsets never split a UTF-8 character', () => {
  assert.equal(incompleteUtf8Tail(Buffer.from('ab')), 0)
  const zh = Buffer.from('中😀')
  assert.equal(incompleteUtf8Tail(zh.subarray(0, 2)), 2)
  assert.equal(incompleteUtf8Tail(zh.subarray(0, 3)), 0)
  assert.equal(incompleteUtf8Tail(zh.subarray(0, 6)), 3)
  assert.equal(incompleteUtf8Tail(zh), 0)

  const c = new Collector(1024)
  const all = Buffer.from('输出😀text')
  let text = ''
  let offset = 0
  for (let i = 0; i < all.length; i++) {
    c.push(all.subarray(i, i + 1))
    const r = c.readFrom(offset)
    text += r.text
    offset = r.nextOffset
  }
  assert.equal(text, '输出😀text')

  // A trimmed tail that starts inside a character skips the partial bytes.
  const small = new Collector(4)
  small.push(Buffer.from('中'))
  small.push(Buffer.from('文x'))
  const r = small.readFrom(0)
  assert.equal(r.lossy, true)
  assert.equal(r.text, '文x')
})
