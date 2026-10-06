import assert from 'node:assert/strict'
import test from 'node:test'
import { actionScript, inputTextCommands, isAsciiTypable, keyCommand } from '../src/env/adb/input.ts'
import { androidKey } from '../src/env/adb/keys.ts'
import { Environment } from '../src/env/environment.ts'
import type { Capture, CaptureOptions, ExecOptions, ExecResult, SpawnSpec, WindowInfo } from '../src/env/types.ts'
import {
  crop,
  decodePng,
  decodeScreencapRaw,
  encodeImage,
  encodePng,
  fitSize,
  resize,
  type RgbImage,
} from '../src/image/codec.ts'
import { AC_CHR, AC_LUM, DC_CHR, DC_LUM, ZIGZAG, encodeJpeg } from '../src/image/jpeg.ts'
import { toEnvActions } from '../src/tools/lease/screen-tools.ts'
import { decodeXml, parseUiautomator } from '../src/tools/screen/android-ui.ts'
import {
  ScreenSession,
  formatElement,
  rectToPhysical,
  toImage,
  toPhysical,
  type Frame,
} from '../src/tools/screen/session.ts'
import { UIA_SCRIPT, listUia, uiaCommand, uiaMapper } from '../src/tools/screen/uia.ts'
import { resolveWindow } from '../src/tools/screen/windows.ts'

function gradient(w: number, h: number): RgbImage {
  const data = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      data[i] = x * 3
      data[i + 1] = y * 5
      data[i + 2] = (x + y) & 0xff
    }
  return { width: w, height: h, data }
}

test('PNG encode/decode round trip and screencap raw', () => {
  const img = gradient(37, 11)
  const back = decodePng(encodePng(img))
  assert.equal(back.width, 37)
  assert.equal(back.height, 11)
  assert.deepEqual(back.data, img.data)
  for (const header of [12, 16]) {
    const raw = Buffer.alloc(header + 2 * 1 * 4)
    raw.writeUInt32LE(2, 0)
    raw.writeUInt32LE(1, 4)
    raw.writeUInt32LE(1, 8)
    raw.set([10, 20, 30, 255, 40, 50, 60, 255], header)
    assert.deepEqual([...decodeScreencapRaw(raw).data], [10, 20, 30, 40, 50, 60])
  }
  assert.throws(() => decodeScreencapRaw(Buffer.alloc(40)))
})

test('resize, crop and fit', () => {
  const flat: RgbImage = { width: 7, height: 5, data: new Uint8Array(7 * 5 * 3).fill(99) }
  assert.ok(resize(flat, 3, 2).data.every(v => v === 99))
  const two: RgbImage = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 200, 100, 50]) }
  assert.deepEqual([...resize(two, 1, 1).data], [100, 50, 25])
  const up = resize(two, 4, 1)
  assert.deepEqual([...up.data.subarray(0, 3)], [0, 0, 0])
  assert.deepEqual([...up.data.subarray(9, 12)], [200, 100, 50])
  const c = crop(gradient(10, 10), { x: 2, y: 3, width: 4, height: 2 })
  assert.equal(c.width, 4)
  assert.equal(c.data[0], 6)
  assert.equal(c.data[1], 15)
  assert.deepEqual(fitSize(2560, 1440, 1280), { width: 1280, height: 720 })
  assert.deepEqual(fitSize(1256, 2760, 1280), { width: 582, height: 1280 })
  assert.deepEqual(fitSize(800, 600, 1280), { width: 800, height: 600 })
  assert.deepEqual(fitSize(300, 100, 1280, 2), { width: 600, height: 200 })
})

test('JPEG encoder structure', () => {
  assert.deepEqual(
    [...ZIGZAG].sort((a, b) => a - b),
    [...Array(64).keys()],
  )
  assert.deepEqual(ZIGZAG.slice(0, 10), [0, 1, 8, 16, 9, 2, 3, 10, 17, 24])
  for (const t of [DC_LUM, DC_CHR, AC_LUM, AC_CHR])
    assert.equal(
      t.bits.reduce((a, b) => a + b, 0),
      t.vals.length,
    )
  const jpg = encodeJpeg(gradient(33, 17), 80)
  assert.deepEqual([...jpg.subarray(0, 2)], [0xff, 0xd8])
  assert.deepEqual([...jpg.subarray(-2)], [0xff, 0xd9])
  const sof = jpg.indexOf(Buffer.from([0xff, 0xc0]))
  assert.equal(jpg.readUInt16BE(sof + 5), 17)
  assert.equal(jpg.readUInt16BE(sof + 7), 33)
  // Entropy data never contains an unstuffed marker.
  const sos = jpg.indexOf(Buffer.from([0xff, 0xda]))
  const body = jpg.subarray(sos + 2 + jpg.readUInt16BE(sos + 2), -2)
  for (let i = 0; i < body.length - 1; i++) if (body[i] === 0xff) assert.equal(body[i + 1], 0)
  assert.equal(encodeImage(gradient(8, 8), 'jpeg').mediaType, 'image/jpeg')
  assert.equal(encodeImage({ width: 64, height: 64, data: new Uint8Array(64 * 64 * 3) }).mediaType, 'image/png')
})

const frame: Frame = { x: 100, y: 50, sx: 0.5, sy: 0.5, width: 640, height: 400, kind: 'screen' }

test('frame coordinate mapping', () => {
  const p = toPhysical(frame, 10, 20)
  assert.deepEqual(p, { x: 120.5, y: 90.5 })
  const back = toImage(frame, p.x, p.y)
  assert.ok(Math.abs(back.x - 10) < 1e-9 && Math.abs(back.y - 20) < 1e-9)
  assert.deepEqual(rectToPhysical(frame, { x: 10, y: 10, width: 50, height: 20 }), {
    x: 120,
    y: 70,
    width: 100,
    height: 40,
  })
  assert.deepEqual(toPhysical({ ...frame, x: 0, y: 0, sx: 1, sy: 1 }, 7, 9), { x: 7, y: 9 })
  const line = formatElement(
    {
      index: 3,
      depth: 0,
      role: 'Button',
      text: 'OK',
      id: 'ok',
      bounds: { x: 200, y: 150, width: 100, height: 40 },
      flags: ['clickable'],
    },
    frame,
  )
  assert.equal(line, '[3] Button "OK" #ok @(75,60) 50x20 [clickable]')
})

class FakeEnv extends Environment {
  captures: CaptureOptions[] = []
  img = gradient(400, 200)
  wins: WindowInfo[] = []
  execOut = ''
  constructor(kind: 'server' | 'adb' = 'server') {
    super({ id: 'fake', kind })
    this.info = {
      os: 'windows',
      family: 'windows',
      arch: 'x64',
      hostname: '',
      user: '',
      home: '',
      cwd: '',
      pathSep: '\\',
      shell: '',
      caps: ['screenshot', 'input', 'windows', 'uia'],
      version: '',
    }
  }
  override capture(opts: CaptureOptions = {}): Promise<Capture> {
    this.captures.push(opts)
    return Promise.resolve({
      image: this.img,
      width: this.img.width,
      height: this.img.height,
      rect: { x: 0, y: 0, width: this.img.width, height: this.img.height },
    })
  }
  override windows(): Promise<WindowInfo[]> {
    return Promise.resolve(this.wins)
  }
  override exec(_spec: SpawnSpec, _opts?: ExecOptions): Promise<ExecResult> {
    return Promise.resolve({
      code: 0,
      signal: null,
      stdout: Buffer.from(this.execOut),
      stderr: Buffer.alloc(0),
      truncated: false,
      timedOut: false,
    })
  }
}

test('screen session: downscale, zoom and action mapping', async () => {
  const env = new FakeEnv()
  const s = new ScreenSession(env)
  const shot = await s.shoot({ maxEdge: 256 })
  assert.equal(shot.frame.width, 256)
  assert.equal(shot.frame.height, 128)
  assert.equal(shot.frame.sx, 0.64)
  assert.equal(decodePng(shot.data).width, 256)
  // Zoom into 64x32 image pixels = 100x50 physical, enlarged 2x.
  const zoom = await s.shoot({ region: { x: 64, y: 32, width: 64, height: 32 } })
  assert.deepEqual(zoom.rect, { x: 100, y: 50, width: 100, height: 50 })
  assert.equal(zoom.frame.width, 200)
  assert.equal(zoom.frame.kind, 'region')
  const px = decodePng(zoom.data)
  assert.equal(px.data[0], (100 * 3) & 0xff)
  // Coordinates now refer to the zoomed image.
  const acts = await toEnvActions(s, [
    { kind: 'click', x: 0, y: 0 },
    { kind: 'drag', x: 0, y: 0, x2: 198, y2: 98 },
  ])
  assert.deepEqual(acts[0], { kind: 'click', x: 100, y: 50 })
  assert.deepEqual(acts[1]?.path, [
    [100, 50],
    [199, 99],
  ])
  s.elements = [{ index: 0, depth: 0, role: 'Edit', bounds: { x: 10, y: 10, width: 20, height: 10 }, flags: [] }]
  const typed = await toEnvActions(s, [
    { kind: 'type', element: 0, text: 'hi' },
    { kind: 'long_press', x: 10, y: 10 },
  ])
  assert.deepEqual(
    typed.map(a => a.kind),
    ['click', 'wait', 'type', 'mouse_down', 'wait', 'mouse_up'],
  )
  assert.equal(typed[0]?.x, 20)
  await assert.rejects(() => toEnvActions(s, [{ kind: 'click', element: 5 }]), /no element \[5\]/)
})

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
  <node index="0" text="" resource-id="com.example:id/row" class="android.widget.LinearLayout" package="com.example" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,200][1080,400]">
    <node index="0" text="Wi&#8209;Fi &amp; network" resource-id="android:id/title" class="android.widget.TextView" package="com.example" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,220][600,300]" />
    <node index="1" text="" resource-id="com.example:id/toggle" class="android.widget.Switch" package="com.example" content-desc="" checkable="true" checked="true" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[900,250][1000,350]" />
  </node>
  <node index="1" text="" resource-id="com.example:id/search" class="android.widget.EditText" package="com.example" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[0,500][1080,600]" hint="Search" />
  <node index="2" text="Hidden" resource-id="" class="android.widget.TextView" package="com.example" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,3000][100,3100]" />
  <node index="3" text="" resource-id="" class="android.view.View" package="com.example" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][0,0]" />
</node></hierarchy>`

test('uiautomator parsing and filters', () => {
  assert.equal(decodeXml('a&amp;b&#x4E2D;&lt;&#65;'), 'a&b中<A')
  const els = parseUiautomator(XML, { screen: { width: 1080, height: 2400 } })
  assert.deepEqual(
    els.map(e => [e.index, e.role, e.text, e.id, e.flags.join(',')]),
    [
      [0, 'LinearLayout', 'Wi‑Fi & network', 'row', 'clickable'],
      [1, 'Switch', undefined, 'toggle', 'clickable,checked'],
      [2, 'EditText', undefined, 'search', 'clickable,long-clickable,editable,focused'],
    ],
  )
  assert.equal(els[2]?.value, 'hint: Search')
  assert.deepEqual(els[0]?.bounds, { x: 0, y: 200, width: 1080, height: 200 })
  const all = parseUiautomator(XML, { filter: 'all' })
  assert.equal(all.length, 6)
  assert.equal(all[2]?.depth, 2)
  assert.deepEqual(
    parseUiautomator(XML, { query: 'TOGGLE' }).map(e => e.id),
    ['toggle'],
  )
  assert.deepEqual(
    parseUiautomator(XML, { filter: 'interactive' }).map(e => e.id),
    ['row', 'toggle', 'search'],
  )
})

test('android input commands', () => {
  assert.deepEqual(inputTextCommands("it's a test"), [`input text 'it'\\''s%sa%stest'`])
  assert.deepEqual(inputTextCommands('50%s off\nnext\tx'), [
    "input text '50%'",
    "input text 's%soff'",
    'input keyevent 66',
    "input text 'next'",
    'input keyevent 61',
    "input text 'x'",
  ])
  assert.equal(inputTextCommands('a'.repeat(450)).length, 3)
  assert.ok(isAsciiTypable('hello\n'))
  assert.ok(!isAsciiTypable('你好'))
  assert.equal(androidKey('home'), 3)
  assert.equal(androidKey('A'), 29)
  assert.equal(androidKey('7'), 14)
  assert.equal(androidKey('66'), 66)
  assert.equal(androidKey('KEYCODE_ENTER'), 66)
  assert.equal(androidKey('f5'), 135)
  assert.equal(androidKey('media_record'), 'KEYCODE_MEDIA_RECORD')
  assert.equal(keyCommand('ctrl+a'), 'input keycombination 113 29')
  assert.equal(keyCommand('back', { repeat: 3 }), 'input keyevent 4 4 4')
  assert.equal(keyCommand('power', { holdMs: 1000 }), 'input keyevent --longpress 26')
  const screen = { width: 1000, height: 2000 }
  assert.equal(actionScript({ kind: 'click', x: 10.4, y: 20.6 }, screen), 'input tap 10 21')
  assert.match(
    actionScript({ kind: 'click', x: 1, y: 2, count: 2 }, screen),
    /^input tap 1 2 & sleep 0\.12; input tap 1 2; wait$/,
  )
  assert.equal(actionScript({ kind: 'long_press', x: 1, y: 2 }, screen), 'input swipe 1 2 1 2 800')
  assert.equal(
    actionScript({ kind: 'swipe', x: 1, y: 2, x2: 3, y2: 4, durationMs: 100 }, screen),
    'input swipe 1 2 3 4 100',
  )
  assert.equal(actionScript({ kind: 'drag', x: 1, y: 2, x2: 3, y2: 4 }, screen), 'input draganddrop 1 2 3 4 800')
  assert.match(
    actionScript(
      {
        kind: 'drag',
        path: [
          [0, 0],
          [5, 5],
          [9, 9],
        ],
        durationMs: 200,
      },
      screen,
    ),
    /^input motionevent DOWN 0 0; sleep 0\.100; input motionevent MOVE 5 5; .*input motionevent UP 9 9$/,
  )
  // dy 2 = 20% of the height, finger moves up from 1200 to 800.
  assert.equal(actionScript({ kind: 'scroll', x: 500, y: 1000, dy: 2 }, screen), 'input swipe 500 1200 500 800 450')
  assert.equal(actionScript({ kind: 'scroll', dy: -100 }, screen), 'input swipe 500 100 500 1900 450')
  assert.throws(() => actionScript({ kind: 'move', x: 1, y: 1 }, screen), /not available on Android/)
  assert.throws(() => actionScript({ kind: 'click' }, screen), /needs x, y/)
})

const win = (over: Partial<WindowInfo>): WindowInfo => ({
  hwnd: 1,
  title: '',
  class: '',
  pid: 1,
  process: 'app.exe',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  visible: true,
  minimized: false,
  maximized: false,
  foreground: false,
  topmost: false,
  ...over,
})

test('window resolution', async () => {
  const env = new FakeEnv()
  env.wins = [
    win({ hwnd: 10, title: 'Untitled - Notepad', process: 'Notepad.exe' }),
    win({ hwnd: 20, title: 'Inbox - Mail', foreground: true }),
    win({ hwnd: 30, title: 'notepad', process: 'other.exe' }),
  ]
  assert.equal((await resolveWindow(env, undefined)).hwnd, 20)
  assert.equal((await resolveWindow(env, '10')).hwnd, 10)
  assert.equal((await resolveWindow(env, 'notepad')).hwnd, 30)
  assert.equal((await resolveWindow(env, 'mail')).hwnd, 20)
  assert.equal((await resolveWindow(env, 'Notepad.exe')).hwnd, 10)
  await assert.rejects(() => resolveWindow(env, 'zzz'), /no window matches/)
})

test('UI Automation request encoding, coordinate mapping and listing', async () => {
  const b64 = uiaCommand({ op: 'list', hwnd: 5, name: "it's 中" })
  const script = Buffer.from(b64, 'base64').toString('utf16le')
  assert.ok(script.includes(`'{"op":"list","hwnd":5,"name":"it''s \\u4e2d"}'`))
  assert.ok(!script.includes('__REQ__'))
  assert.ok(UIA_SCRIPT.includes('GetUpdatedCache'))
  const ident = uiaMapper([120, 120, 960, 660], { x: 129, y: 120, width: 942, height: 651 })
  assert.deepEqual(ident([10, 20, 30, 40]), { x: 10, y: 20, width: 30, height: 40 })
  const scaled = uiaMapper([80, 80, 640, 440], { x: 120, y: 120, width: 960, height: 660 })
  assert.deepEqual(scaled([100, 100, 10, 10]), { x: 150, y: 150, width: 15, height: 15 })

  const env = new FakeEnv()
  env.execOut = JSON.stringify({
    root: [0, 0, 500, 400],
    truncated: false,
    items: [
      {
        d: 0,
        p: '',
        t: 'Window',
        n: 'App',
        id: '',
        c: '',
        r: [0, 0, 500, 400],
        en: true,
        off: false,
        foc: false,
        kf: false,
        pat: [],
        v: null,
        rid: [1],
      },
      {
        d: 1,
        p: '/0',
        t: 'Button',
        n: 'OK',
        id: 'ok',
        c: '',
        r: [10, 10, 50, 20],
        en: true,
        off: false,
        foc: false,
        kf: true,
        pat: ['invoke'],
        v: null,
        rid: [2],
      },
      {
        d: 2,
        p: '/0/0',
        t: 'Text',
        n: 'OK',
        id: '',
        c: '',
        r: [12, 12, 20, 10],
        en: true,
        off: false,
        foc: false,
        kf: false,
        pat: [],
        v: null,
        rid: [3],
      },
      {
        d: 1,
        p: '/1',
        t: 'Edit',
        n: '',
        id: 'q',
        c: '',
        r: [10, 50, 200, 20],
        en: false,
        off: false,
        foc: true,
        kf: true,
        pat: 'value',
        v: 'abc',
        rid: 4,
      },
      {
        d: 1,
        p: '/2',
        t: 'Text',
        n: 'gone',
        id: '',
        c: '',
        r: [0, 0, 1, 1],
        en: true,
        off: true,
        foc: false,
        kf: false,
        pat: null,
        v: null,
        rid: [5],
      },
      {
        d: 1,
        p: '/3',
        t: 'Pane',
        n: '',
        id: '',
        c: '',
        r: null,
        en: true,
        off: false,
        foc: false,
        kf: false,
        pat: [],
        v: null,
        rid: [6],
      },
    ],
  })
  const { elements } = await listUia(env, win({ hwnd: 7, width: 500, height: 400 }))
  assert.deepEqual(
    elements.map(e => [e.role, e.text, e.id, e.value, e.flags.join(',')]),
    [
      ['Window', 'App', undefined, undefined, ''],
      ['Button', 'OK', 'ok', undefined, 'invoke'],
      ['Edit', undefined, 'q', 'abc', 'value,focused,disabled'],
    ],
  )
  assert.deepEqual(elements[2]?.ref, { runtimeId: [4], path: '/1', hwnd: 7 })
  env.execOut = '{"error":"boom"}'
  await assert.rejects(() => listUia(env, win({})), /UI Automation: boom/)
})
