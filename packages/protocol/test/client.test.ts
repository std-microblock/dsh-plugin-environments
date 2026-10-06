import assert from 'node:assert/strict'
import test from 'node:test'
import { CallbackTransport, EnvClient, EnvError, FrameDecoder, encodeFrame, type FrameHeader } from '../src/index.ts'

test('frames round-trip across arbitrary chunk boundaries', () => {
  const frames: [FrameHeader, string][] = []
  const decoder = new FrameDecoder((h, p) => frames.push([h, p.toString()]))
  const bytes = Buffer.concat([
    encodeFrame({ t: 'data', ch: 1 }, Buffer.from('hello')),
    encodeFrame({ t: 'eof', ch: 1 }),
    encodeFrame({ t: 'data', ch: 2 }, new Uint8Array([119, 111, 114, 108, 100])),
  ])
  for (let i = 0; i < bytes.length; i += 3) decoder.push(bytes.subarray(i, i + 3))
  assert.deepEqual(frames, [
    [{ t: 'data', ch: 1 }, 'hello'],
    [{ t: 'eof', ch: 1 }, ''],
    [{ t: 'data', ch: 2 }, 'world'],
  ])
})

test('bad frame lengths are protocol errors', () => {
  const decoder = new FrameDecoder(() => {})
  const bad = Buffer.alloc(8)
  bad.writeUInt32BE(1, 0)
  assert.throws(
    () => decoder.push(bad),
    (e: unknown) => e instanceof EnvError && e.code === 'PROTOCOL',
  )
})

/** In-memory server speaking just enough of the protocol for the client. */
function fakeServer(handle: (header: FrameHeader, payload: Buffer, reply: (h: object, p?: Buffer) => void) => void) {
  const box: { toClient?: (d: Buffer) => void } = {}
  const decoder = new FrameDecoder((h, p) => handle(h, p, (rh, rp) => box.toClient?.(encodeFrame(rh, rp))))
  const transport = new CallbackTransport({
    write: buf => queueMicrotask(() => decoder.push(buf)),
    end: () => {},
    destroy: () => {},
  })
  box.toClient = d => queueMicrotask(() => transport.emit('data', d))
  return transport
}

test('handshake, typed requests, channels and errors', async () => {
  const transport = fakeServer((h, p, reply) => {
    if (h.t === 'hello') {
      if (h['token'] === 'secret')
        reply({ t: 'hello', v: 1, ok: true, info: { os: 'linux', family: 'posix', caps: ['fs'] } })
      else reply({ t: 'hello', v: 1, ok: false, error: { code: 'AUTH', message: 'bad token' } })
    } else if (h.t === 'req' && h['op'] === 'fs.stat') {
      reply({ t: 'res', id: h['id'], ok: true, result: { type: 'file', size: 3, mtimeMs: 1, mode: 420 } })
    } else if (h.t === 'req' && h['op'] === 'fs.readStream') {
      // Data for the channel arrives before the response that announces it.
      reply({ t: 'data', ch: 9 }, Buffer.from('abc'))
      reply({ t: 'eof', ch: 9 })
      reply({ t: 'res', id: h['id'], ok: true, result: { ch: 9, size: 3 } })
      reply({ t: 'close', ch: 9 })
    } else if (h.t === 'req') {
      reply({ t: 'res', id: h['id'], ok: false, error: { code: 'ENOENT', message: `no ${String(p.length)}` } })
    }
  })
  const client = new EnvClient(transport, { token: 'secret', pingMs: 0 })
  const info = await client.connect()
  assert.equal(info.os, 'linux')
  const st = await client.call('fs.stat', { path: '/x' })
  assert.equal(st?.size, 3)
  const { ch } = await client.call('fs.readStream', { path: '/x' })
  const chunks: Buffer[] = []
  for await (const c of client.channel(ch).readable()) chunks.push(c as Buffer)
  assert.equal(Buffer.concat(chunks).toString(), 'abc')
  await assert.rejects(client.call('fs.remove', { path: '/y' }), { code: 'ENOENT' })
  client.close()
  await assert.rejects(client.call('fs.stat', { path: '/x' }), { code: 'CLOSED' })
})

test('rejected handshake reports AUTH', async () => {
  const transport = fakeServer((h, _p, reply) => {
    if (h.t === 'hello') reply({ t: 'hello', v: 1, ok: false, error: { code: 'AUTH', message: 'bad token' } })
  })
  const client = new EnvClient(transport, { token: 'wrong', pingMs: 0 })
  await assert.rejects(client.connect(), { code: 'AUTH' })
})
