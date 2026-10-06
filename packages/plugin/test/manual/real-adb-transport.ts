// Manual smoke test of the network transports against a real Android device (linux-arm64):
// reverse TCP + WebSocket (device dials the plugin through `adb reverse`) and plugin-dials-WS
// (`adb forward`). Usage:
//   node packages/plugin/test/manual/real-adb-transport.ts <serial> <path-to-aarch64-musl-binary>
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateSecret } from '@dsh-environments/protocol'
import { openServer } from '../../src/env/server/connect.ts'
import { sanitizeReverseSettings } from '../../src/env/server/reverse.ts'
import { EnvironmentManager } from '../../src/manager/manager.ts'

const [serial = '', binary = ''] = process.argv.slice(2)
if (!serial || !binary) throw new Error('usage: real-adb-transport.ts <serial> <binary>')
const remote = '/data/local/tmp/dsh-env-transport-smoke'
const adb = (...args: string[]) => {
  const r = spawnSync('adb', ['-s', serial, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`adb ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}
const shell = (command: string, input: string) => {
  const child = spawn('adb', ['-s', serial, 'shell', command], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.write(input)
  child.stderr.on('data', (d: Buffer) => process.stderr.write(`[device] ${d.toString()}`))
  return child
}
const until = async (fn: () => boolean, ms = 20000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise(r => setTimeout(r, 100))
  }
}

adb('push', binary, remote)
adb('shell', `chmod 700 ${remote}`)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adb-transport-'))
const manager = new EnvironmentManager({ dataDir: tmp, autoDiscoverAdb: false })
manager.load()
const children: ReturnType<typeof spawn>[] = []
try {
  await manager.setReverseSettings(
    sanitizeReverseSettings({
      tcp: { enabled: true, host: '127.0.0.1', port: 0 },
      ws: { enabled: true, host: '127.0.0.1', port: 0, path: '/rev' },
    }),
  )
  const st = manager.reverse.describe()
  adb('reverse', 'tcp:17462', `tcp:${st.tcp.port}`)
  adb('reverse', 'tcp:17463', `tcp:${st.ws.port}`)
  const def = manager.upsert({ id: 'phone', name: 'phone', kind: 'reverse', config: {} })
  for (const url of ['tcp://127.0.0.1:17462', 'ws://127.0.0.1:17463/rev']) {
    const t0 = Date.now()
    const child = shell(`${remote} connect ${url} --id phone --token-stdin --lifeline`, `${def.config.token}\n`)
    children.push(child)
    await until(() => manager.reverse.connected('phone'))
    const env = await manager.open(def)
    const r = await env.exec({ command: 'uname -sm; id -u' })
    const big = Buffer.alloc(4 * 1024 * 1024, 5)
    await env.writeFile('/data/local/tmp/dsh-transport-smoke.bin', big)
    const back = await env.readFile('/data/local/tmp/dsh-transport-smoke.bin')
    await env.remove('/data/local/tmp/dsh-transport-smoke.bin')
    console.log(
      `reverse ${url}: ${r.stdout.toString().trim().replace(/\n/g, ' / ')}; 4 MiB round trip ok=${back.equals(big)}; ${Date.now() - t0} ms`,
    )
    await env.close()
    child.stdin.end()
    child.kill()
    // adb does not reliably propagate stdin EOF; stop the connector explicitly.
    spawnSync('adb', ['-s', serial, 'shell', `pkill -f '${remote} connect'`])
    await until(() => !manager.reverse.connected('phone'))
  }

  const secret = generateSecret()
  const srv = shell(`${remote} serve --listen ws://127.0.0.1:17470/x --token-stdin --exit-idle`, `${secret}\n`)
  children.push(srv)
  await new Promise<void>(resolve =>
    srv.stdout.on('data', (d: Buffer) => d.toString().includes('listening=') && resolve()),
  )
  adb('forward', 'tcp:17470', 'tcp:17470')
  const env = await openServer({ id: 'phone-ws', url: 'ws://127.0.0.1:17470/x', token: secret })
  const r = await env.exec({ command: 'getprop ro.product.model' })
  console.log(`plugin dials ws: model ${r.stdout.toString().trim()}, os ${env.info?.os} ${env.info?.arch}`)
  await assertRejects(openServer({ id: 'bad', url: 'ws://127.0.0.1:17470/x', token: 'wrong' }))
  await env.close()
  const exited = await new Promise(r => {
    srv.once('exit', () => r(true))
    setTimeout(() => r(false), 5000)
  })
  console.log(`server exited after the last client (exit-idle): ${String(exited)}`)
} finally {
  for (const c of children) c.kill()
  spawnSync('adb', ['-s', serial, 'reverse', '--remove', 'tcp:17462'])
  spawnSync('adb', ['-s', serial, 'reverse', '--remove', 'tcp:17463'])
  spawnSync('adb', ['-s', serial, 'forward', '--remove', 'tcp:17470'])
  spawnSync('adb', ['-s', serial, 'shell', `rm -f ${remote}; pkill -f ${remote}`])
  await manager.dispose()
  fs.rmSync(tmp, { recursive: true, force: true })
}

async function assertRejects(p: Promise<unknown>): Promise<void> {
  try {
    await p
  } catch (e) {
    console.log(`wrong secret rejected: ${(e as Error).message}`)
    return
  }
  throw new Error('wrong secret was accepted')
}
