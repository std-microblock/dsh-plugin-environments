// Computer-use smoke test on the first adb device (harmless: opens Settings search, types
// "wifi", goes back home). node packages/plugin/test/manual/real-computer-use-android.ts <outDir>
import fs from 'node:fs'
import path from 'node:path'
import { errorMessage } from '@dsh-environments/protocol'
import { AdbEnvironment } from '../../src/env/adb/adb-env.ts'
import { listAdbDevices } from '../../src/env/adb/devices.ts'
import { toEnvActions } from '../../src/tools/lease/screen-tools.ts'
import { parseUiautomator } from '../../src/tools/screen/android-ui.ts'
import { ScreenSession, describeFrame, formatElement } from '../../src/tools/screen/session.ts'

const out = process.argv[2] ?? '.cache/computer-use'
fs.mkdirSync(out, { recursive: true })
const serial = (await listAdbDevices()).find(d => d.state === 'device')?.serial
const env = await new AdbEnvironment({ id: 'phone', name: 'Phone', serial }).open()
const s = new ScreenSession(env)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const step = async (name: string, fn: () => Promise<unknown>) => {
  const t = Date.now()
  try {
    const r = await fn()
    console.log(`OK   ${name} (${Date.now() - t}ms)`, typeof r === 'string' ? r : JSON.stringify(r))
  } catch (e) {
    console.log(`FAIL ${name}: ${errorMessage(e)}`)
  }
}
const shot = async (file: string, opts = {}) => {
  const r = await s.shoot(opts)
  fs.writeFileSync(path.join(out, `${file}.${r.mediaType === 'image/png' ? 'png' : 'jpg'}`), r.data)
  return `${describeFrame(r.frame, r.rect)} ${r.mediaType} ${r.data.length} bytes`
}
const ui = async (query?: string) => {
  const xml = await env.uiDump()
  s.elements = parseUiautomator(xml, { query, screen: await env.screenSize() })
  const f = await s.ensureFrame()
  return s.elements.map(e => formatElement(e, f)).join('\n')
}
const act = async (actions: Parameters<typeof toEnvActions>[1]) => env.input(await toEnvActions(s, actions))

await step('device info', () => env.deviceInfo())
await step('unlock (wake)', () => env.unlock())
await step('home', () => act([{ kind: 'key', key: 'home' }]))
await sleep(800)
await step('screenshot home', () => shot('android-home'))
await step('ui list home', () => ui())
await step('open settings', async () => {
  await env.check('am start -S -W -a android.settings.SETTINGS')
  await sleep(1200)
  return (await env.foreground()).package
})
await step('screenshot settings', () => shot('android-settings'))
await step('ui list settings', () => ui())
await step('scroll down 3 notches', async () => {
  await act([{ kind: 'scroll', dy: 3 }])
  await sleep(800)
  return shot('android-settings-scrolled')
})
await step('scroll back up', () => act([{ kind: 'scroll', dy: -6 }]))
await sleep(800)
await step('find search', () => ui('search_src_text'))
await step('tap search + type ascii', async () => {
  const target = s.elements[0]
  if (!target) throw new Error('no search element')
  await act([{ kind: 'click', element: target.index }])
  await sleep(1200)
  await act([{ kind: 'type', text: 'wifi 50%s' }])
  await sleep(1000)
  return shot('android-search-typed')
})
await step('edit fields after typing', () => ui())
await step('ctrl+a, del via keycombination', async () => {
  await act([
    { kind: 'key', key: 'ctrl+a' },
    { kind: 'key', key: 'del' },
  ])
  await sleep(500)
  return ui()
})
await step('non-ASCII typing (expected: clear unsupported error without ADB Keyboard)', () =>
  act([{ kind: 'type', text: '你好' }]),
)
await step('zoom', () => shot('android-zoom', { region: { x: 0, y: 0, width: s.frame?.width ?? 100, height: 200 } }))
await step('back, back, home', async () => {
  await act([
    { kind: 'key', key: 'back' },
    { kind: 'wait', ms: 400 },
    { kind: 'key', key: 'back' },
    { kind: 'key', key: 'home' },
  ])
  await sleep(800)
  return (await env.foreground()).package
})
await step('final screenshot', () => shot('android-final'))
await env.close()
