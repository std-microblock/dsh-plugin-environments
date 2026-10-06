// Exercise AdbEnvironment against the first real device:
//   node packages/plugin/test/manual/real-adb.ts
import fs from 'node:fs'
import { errorCode, errorMessage } from '@dsh-environments/protocol'
import { AdbEnvironment } from '../../src/env/adb/adb-env.ts'
import { listAdbDevices } from '../../src/env/adb/devices.ts'

const devices = await listAdbDevices()
console.log('devices', devices)
const serial = devices.find(d => d.state === 'device')?.serial
const env = new AdbEnvironment({ id: 'phone', name: 'Phone', serial })
const step = async (name: string, fn: () => Promise<unknown>) => {
  const t = Date.now()
  try {
    const r = await fn()
    console.log(
      `OK   ${name} (${Date.now() - t}ms)`,
      typeof r === 'string' ? r.slice(0, 300) : JSON.stringify(r)?.slice(0, 300),
    )
  } catch (e) {
    console.log(`FAIL ${name}: ${errorCode(e) ?? ''} ${errorMessage(e)}`)
  }
}
await step('open', async () => {
  await env.open()
  return env.info
})
const root = '/data/local/tmp/dsh-real-test'
await step('mkdir', () => env.mkdir(`${root}/sub dir`, { recursive: true }))
await step('write', () => env.writeFile(`${root}/sub dir/hello.txt`, Buffer.from('hello phone\nsecond line\n')))
await step('read', async () => (await env.readFile(`${root}/sub dir/hello.txt`)).toString())
await step('readRange', async () =>
  (await env.readFile(`${root}/sub dir/hello.txt`, { offset: 6, length: 5 })).toString(),
)
await step('append', () => env.writeFile(`${root}/sub dir/hello.txt`, Buffer.from('third\n'), { mode: 'append' }))
await step('stat', () => env.stat(`${root}/sub dir/hello.txt`))
await step('stat missing', () => env.stat(`${root}/missing`))
await step('readdir', () => env.readdir(`${root}/sub dir`))
await step('readdir sdcard', async () => (await env.readdir('/sdcard')).slice(0, 5))
await step('glob', () => env.glob('**/*.txt', { cwd: root }))
await step('grep', () => env.grep('phone', { cwd: root }))
await step('grep glob', () => env.grep('line', { cwd: root, glob: '*.txt', ignoreCase: true }))
await step('grep filesOnly', () => env.grep('third', { cwd: root, filesOnly: true }))
await step('exec', async () => {
  const r = await env.exec({ command: 'echo hi; id; exit 3' })
  return `${r.code} ${r.stdout.toString()}`
})
await step('exec cwd', async () => (await env.exec({ command: 'pwd', cwd: root })).stdout.toString())
await step('exec stdin', async () => (await env.exec({ command: 'cat' }, { stdin: 'piped-in\n' })).stdout.toString())
await step('pty', async () => {
  const p = await env.spawn({ command: 'echo ptyok', pty: { rows: 24, cols: 80 } })
  let out = ''
  p.stdout.on('data', (d: Buffer) => {
    out += d.toString()
  })
  await p.exited
  return out
})
await step('rename', () => env.rename(`${root}/sub dir/hello.txt`, `${root}/sub dir/renamed.txt`))
await step('realpath', () => env.realpath('/sdcard'))
await step('screenshot', async () => {
  const s = await env.screenshot()
  fs.mkdirSync('.cache', { recursive: true })
  fs.writeFileSync('.cache/phone.png', s.png)
  return `${s.width}x${s.height} ${s.png.length}`
})
await step('uiDump', async () => (await env.uiDump()).slice(0, 200))
await step('forward', async () => {
  const t = await env.forward({ remotePort: 8080 })
  await t.close()
  return t.localPort
})
await step('reverse', async () => {
  const t = await env.reverse({ remotePort: 0, localPort: 19387 })
  await t.close()
  return t.remotePort
})
await step('remove', () => env.remove(root, { recursive: true }))
await step('gone', () => env.stat(root))
