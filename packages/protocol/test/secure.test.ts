import assert from 'node:assert/strict'
import http from 'node:http'
import type net from 'node:net'
import test from 'node:test'
import {
  CallbackTransport,
  deriveKeys,
  encodeWsFrame,
  RecordCipher,
  secureInitiate,
  secureRespond,
  WsDecoder,
  wsAccept,
  wsAcceptKey,
  wsConnect,
  type Transport,
  type WsFrame,
} from '../src/index.ts'

/** Two in-memory transports wired to each other; `tap` may rewrite bytes a→b. */
function pipePair(tap: (d: Buffer) => Buffer = d => d): [CallbackTransport, CallbackTransport] {
  const box: { a?: CallbackTransport; b?: CallbackTransport } = {}
  const close = () => {
    box.a?.emit('close')
    box.b?.emit('close')
  }
  const a = new CallbackTransport({
    write: d => queueMicrotask(() => box.b?.push(tap(Buffer.from(d)))),
    end: close,
    destroy: close,
  })
  const b = new CallbackTransport({
    write: d => queueMicrotask(() => box.a?.push(Buffer.from(d))),
    end: close,
    destroy: close,
  })
  box.a = a
  box.b = b
  return [a, b]
}

const next = (t: Transport) => new Promise<Buffer>(resolve => t.on('data', resolve))

test('key schedule matches the Rust known-answer vectors', () => {
  const k = deriveKeys('s3cret', Buffer.alloc(32, 1), Buffer.alloc(32, 2), 'env1', Buffer.from('transcript'))
  assert.equal(k.i2r.toString('hex'), 'e9b651db395dfa3b9061eda8c64ed31a4508a2aa0c328d847749631742c0df0a')
  assert.equal(k.r2i.toString('hex'), 'f67b710eeb64e796ca026c0839fc77a7740c1231b34e8129e3a9c32911b37f9d')
  assert.equal(k.confirmI.toString('hex'), 'f9ffda2f74147fcb46dd2250f57fdc7853284c3ef757c1e1f1edbe5463834e74')
  assert.equal(k.confirmR.toString('hex'), '739bee7e2693c60b817611d9f5fe680d58bc15697807c2837b0deb47ed36c21d')
  const rec = new RecordCipher(k.i2r).seal(Buffer.from('hello'))
  assert.equal(rec.toString('hex'), '00000015b4732d8e75c46eee411a4f1d1ba0bf09b40d323331')
})

test('records reject tampering and replay', () => {
  const key = Buffer.alloc(32, 7)
  const tx = new RecordCipher(key)
  const rx = new RecordCipher(key)
  const r0 = tx.seal(Buffer.from('one'))
  assert.equal(rx.open(r0.subarray(0, 4), r0.subarray(4)).toString(), 'one')
  assert.throws(() => rx.open(r0.subarray(0, 4), r0.subarray(4)), { code: 'PROTOCOL' })
  const rx2 = new RecordCipher(key)
  const r1 = new RecordCipher(key).seal(Buffer.from('two'))
  r1[5] = (r1[5] ?? 0) ^ 1
  assert.throws(() => rx2.open(r1.subarray(0, 4), r1.subarray(4)), { code: 'PROTOCOL' })
})

test('secure handshake: mutual auth, data both ways', async () => {
  const [a, b] = pipePair()
  const responder = secureRespond(b, id => (id === 'env1' ? 'secret-1' : undefined))
  const ta = await secureInitiate(a, { secret: 'secret-1', id: 'env1' })
  const { transport: tb, id } = await responder
  assert.equal(id, 'env1')
  const big = Buffer.alloc(200_000, 9)
  const got: Buffer[] = []
  const done = new Promise<void>(resolve =>
    tb.on('data', d => {
      got.push(d)
      if (Buffer.concat(got).length >= big.length) resolve()
    }),
  )
  ta.write(big)
  await done
  assert.ok(Buffer.concat(got).equals(big))
  const reply = next(ta)
  tb.write(Buffer.from('pong'))
  assert.equal((await reply).toString(), 'pong')
})

test('secure handshake: wrong secret and unknown id are rejected', async () => {
  {
    const [a, b] = pipePair()
    const responder = secureRespond(b, () => 'right')
    responder.catch(() => {})
    await assert.rejects(secureInitiate(a, { secret: 'wrong' }), { code: 'AUTH' })
    await assert.rejects(responder)
  }
  {
    const [a, b] = pipePair()
    const responder = secureRespond(b, () => undefined)
    const initiator = secureInitiate(a, { secret: 'x', id: 'nobody' })
    initiator.catch(() => {})
    await assert.rejects(responder, { code: 'AUTH' })
    await assert.rejects(initiator, { code: 'AUTH' })
  }
})

test('secure channel: tampered records close the connection', async () => {
  let flip = false
  const [a, b] = pipePair(d => {
    if (flip) {
      const c = Buffer.from(d)
      c[c.length - 1] = (c[c.length - 1] ?? 0) ^ 0xff
      return c
    }
    return d
  })
  const responder = secureRespond(b, () => 's')
  const ta = await secureInitiate(a, { secret: 's' })
  const { transport: tb } = await responder
  const failed = new Promise<Error>(resolve => tb.on('error', resolve))
  tb.on('data', () => assert.fail('tampered data must not be delivered'))
  flip = true
  ta.write(Buffer.from('evil'))
  assert.match((await failed).message, /authentication failed/)
})

test('websocket frame codec', () => {
  assert.equal(wsAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  for (const n of [0, 5, 125, 126, 65535, 65536, 100_000]) {
    const payload = Buffer.alloc(n, 3)
    for (const mask of [false, true]) {
      const frames: WsFrame[] = []
      const dec = new WsDecoder(mask, f => frames.push(f))
      const bytes = encodeWsFrame(2, payload, mask)
      for (let i = 0; i < bytes.length; i += 7000) dec.push(bytes.subarray(i, i + 7000))
      assert.equal(frames.length, 1)
      assert.ok(frames[0]?.payload.equals(payload))
      assert.throws(() => new WsDecoder(!mask, () => {}).push(bytes), { code: 'PROTOCOL' })
    }
  }
})

test('websocket server notices a peer that vanishes without a close frame', async () => {
  const server = http.createServer()
  const accepted = new Promise<Transport>(resolve =>
    server.on('upgrade', (req: http.IncomingMessage, socket, head) => {
      const t = wsAccept(req, socket, head)
      if (t) resolve(t)
    }),
  )
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  try {
    const raw = await new Promise<net.Socket>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
      })
      req.on('upgrade', (_res, socket) => resolve(socket))
      req.on('error', reject)
      req.end()
    })
    const srv = await accepted
    const closed = new Promise<void>(r => srv.on('close', r))
    raw.end() // FIN only, like a killed process behind adb / a proxy
    await closed
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

test('websocket client and server over http upgrade', async () => {
  const server = http.createServer((_req, res) => res.writeHead(404).end())
  const accepted = new Promise<Transport>(resolve =>
    server.on('upgrade', (req: http.IncomingMessage, socket, head) => {
      const t = wsAccept(req, socket, head)
      if (t) resolve(t)
    }),
  )
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  try {
    const client = await wsConnect(`ws://127.0.0.1:${port}/x`)
    const srv = await accepted
    // Secure channel on top of the websocket, like a real reverse connection.
    const responder = secureRespond(srv, () => 'ws-secret')
    const tc = await secureInitiate(client, { secret: 'ws-secret' })
    const { transport: ts } = await responder
    const got = next(ts)
    tc.write(Buffer.from('over ws'))
    assert.equal((await got).toString(), 'over ws')
    const closed = new Promise<void>(r => ts.on('close', r))
    tc.end?.()
    await closed
  } finally {
    server.close()
    server.closeAllConnections()
  }
})
