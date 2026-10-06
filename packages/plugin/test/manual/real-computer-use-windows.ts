// Computer-use smoke test on this Windows desktop against a harmless test window.
//   1. start the WPF test app (see the report: a topmost "DSH Computer-Use Test" window)
//   2. DSH_ENV_SERVER_BIN=<built server> node packages/plugin/test/manual/real-computer-use-windows.ts <outDir>
// It only clicks/types inside that window.
import fs from 'node:fs'
import path from 'node:path'
import { errorMessage } from '@dsh-environments/protocol'
import { openLocal } from '../../src/env/server/connect.ts'
import { ScreenSession, formatElement, describeFrame } from '../../src/tools/screen/session.ts'
import { listUia, actUia } from '../../src/tools/screen/uia.ts'
import { resolveWindow, formatWindow } from '../../src/tools/screen/windows.ts'
import { toEnvActions } from '../../src/tools/lease/screen-tools.ts'

const out = process.argv[2] ?? '.cache/computer-use'
fs.mkdirSync(out, { recursive: true })
const env = await openLocal({ id: 'local', name: 'Local' })
const s = new ScreenSession(env)
const step = async (name: string, fn: () => Promise<unknown>) => {
  const t = Date.now()
  try {
    const r = await fn()
    console.log(`OK   ${name} (${Date.now() - t}ms)`, typeof r === 'string' ? r : JSON.stringify(r))
  } catch (e) {
    console.log(`FAIL ${name}: ${errorMessage(e)}`)
  }
}
const save = (file: string, data: Buffer) => fs.writeFileSync(path.join(out, file), data)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

console.log('caps', env.info?.caps.join(','))
await step('displays', () => env.displays())
await step('full screenshot', async () => {
  const shot = await s.shoot({})
  save(`win-full.${shot.mediaType === 'image/png' ? 'png' : 'jpg'}`, shot.data)
  return `${describeFrame(shot.frame, shot.rect)} ${shot.mediaType} ${shot.data.length} bytes`
})
await step('jpeg screenshot', async () => {
  const shot = await s.shoot({ format: 'jpeg', quality: 80 })
  save('win-full.jpg', shot.data)
  return `${shot.mediaType} ${shot.data.length} bytes`
})
const win = await resolveWindow(env, 'DSH Computer-Use Test')
console.log('test window', formatWindow(win, undefined))
await step('focus', () => env.windowAction(win.hwnd, 'focus'))
await step('window screenshot', async () => {
  const shot = await s.shoot({ window: win, cursor: true })
  save('win-window.png', shot.data)
  return describeFrame(shot.frame, shot.rect)
})
let listing = await listUia(env, win)
s.elements = listing.elements
const frame = await s.ensureFrame()
console.log(listing.elements.map(e => formatElement(e, frame)).join('\n'))
const find = (t: string) => {
  const e = s.elements.find(x => x.text === t || x.id === t)
  if (!e) throw new Error(`no element ${t}`)
  return e
}
await step('type unicode into the editor (click element + type)', async () => {
  const acts = await toEnvActions(s, [
    { kind: 'type', element: find('Editor').index, text: 'Hello 世界 😀 éß\nsecond line\ttab' },
  ])
  await env.input(acts)
  await sleep(400)
  return fs.readFileSync(path.join(out, 'testapp-text.txt'), 'utf8')
})
await step('key combo ctrl+a then type', async () => {
  await env.input(
    await toEnvActions(s, [
      { kind: 'key', key: 'ctrl+a' },
      { kind: 'type', text: 'replaced 替换' },
    ]),
  )
  await sleep(300)
  return fs.readFileSync(path.join(out, 'testapp-text.txt'), 'utf8')
})
await step('double click the button with the mouse (screenshot coordinates)', async () => {
  const btn = find('ClickMe')
  const c = { x: btn.bounds.x + btn.bounds.width / 2, y: btn.bounds.y + btn.bounds.height / 2 }
  const img = { x: (c.x - frame.x) * frame.sx, y: (c.y - frame.y) * frame.sy }
  await env.input(await toEnvActions(s, [{ kind: 'click', x: img.x, y: img.y, count: 2 }]))
  await sleep(300)
  listing = await listUia(env, win, { query: 'clicks' })
  return listing.elements.map(e => e.text).join(',')
})
await step('UIA invoke + toggle + select', async () => {
  const all = (await listUia(env, win)).elements
  s.elements = all
  const r1 = await actUia(env, find('ClickMe'), 'click')
  const r2 = await actUia(env, find('Feature'), 'click')
  const r3 = await actUia(env, find('Cherry'), 'click')
  const after = (await listUia(env, win)).elements.filter(e => /clicks|Enable|Cherry/.test(e.text ?? ''))
  return `${r1.used} ${r2.used} ${r3.used} → ${after.map(e => `${e.text}[${e.flags.join('|')}]`).join(' ')}`
})
await step('scroll + right click in the window', async () => {
  const lb = find('Items')
  await env.input(
    await toEnvActions(s, [
      { kind: 'scroll', element: lb.index, dy: 2 },
      { kind: 'click', element: find('Editor').index, button: 'right' },
      { kind: 'key', key: 'esc' },
    ]),
  )
  await sleep(300)
  return (
    (await listUia(env, win, { filter: 'all', query: 'wheel' })).elements.map(e => e.text).join(',') || '(log empty)'
  )
})
await step('drag select in editor', async () => {
  const ed = find('Editor')
  const y = ed.bounds.y + 20
  const p = (x: number) => [(x - frame.x) * frame.sx, (y - frame.y) * frame.sy]
  await env.input(
    await toEnvActions(s, [{ kind: 'drag', path: [p(ed.bounds.x + 10), p(ed.bounds.x + 200)], duration_ms: 300 }]),
  )
  return 'dragged'
})
await step('zoom region', async () => {
  const ed = find('Editor')
  const shot = await s.shoot({
    region: {
      x: (ed.bounds.x - frame.x) * frame.sx,
      y: (ed.bounds.y - frame.y) * frame.sy,
      width: 300 * frame.sx,
      height: 120 * frame.sy,
    },
  })
  save('win-zoom.png', shot.data)
  return describeFrame(shot.frame, shot.rect)
})
await step('minimize/restore', async () => {
  const a = await env.windowAction(win.hwnd, 'minimize')
  await sleep(300)
  const b = await env.windowAction(win.hwnd, 'restore')
  const c = await env.windowAction(win.hwnd, 'focus')
  return { a, b, c }
})
await step('windows list', async () => (await env.windows()).slice(0, 5).map(w => formatWindow(w, undefined)))
await step('final window screenshot', async () => {
  const shot = await s.shoot({ window: win })
  save('win-window-after.png', shot.data)
  return describeFrame(shot.frame, shot.rect)
})
await env.close()
