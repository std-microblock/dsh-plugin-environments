// Accessibility-tree tool: list on-screen UI elements (Android uiautomator / Windows UI
// Automation) with indexes and screenshot coordinates, and act on them.
import { EnvError } from '@dsh-environments/protocol'
import { AdbEnvironment } from '../../env/adb/adb-env.ts'
import { keyCommand } from '../../env/adb/input.ts'
import type { InputActionFields, WindowInfo } from '../../env/types.ts'
import { clip } from '../common.ts'
import { IMAGE_OUTPUT, type ImageValue } from '../image.ts'
import { dumpPackage, parseUiautomator, type UiFilter } from '../screen/android-ui.ts'
import { center, formatElement, type ScreenSession, type UiElement } from '../screen/session.ts'
import { actUia, listUia, type UiaAction } from '../screen/uia.ts'
import { resolveWindow } from '../screen/windows.ts'
import type { LeaseToolContext } from './context.ts'
import { followUpShot, screenshotValue } from './screen-tools.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const ANDROID_ACTIONS = ['list', 'click', 'long_press', 'set_text', 'scroll'] as const
const WINDOWS_ACTIONS = [
  'list',
  'click',
  'double_click',
  'right_click',
  'set_text',
  'focus',
  'toggle',
  'expand',
  'collapse',
  'select',
  'scroll_into_view',
  'scroll',
] as const

export function addUiTools({ ctx, env, alias: a, label: name, add }: LeaseToolContext, session: ScreenSession): void {
  const android = env instanceof AdbEnvironment ? env : undefined
  const uia = !android && env.hasCap('uia') && env.hasCap('windows')
  if (!android && !uia) return

  /** Fresh listing; stores the elements in the session. */
  const list = async (
    o: {
      filter?: UiFilter | undefined
      query?: string | undefined
      window?: string | undefined
      raw?: boolean | undefined
    },
    signal?: AbortSignal,
  ): Promise<{ header: string; elements: UiElement[]; raw?: string; window?: WindowInfo }> => {
    if (android) {
      const xml = await android.uiDump({ signal })
      if (o.raw) return { header: '', elements: [], raw: xml }
      const screen = await android.screenSize({ signal })
      const elements = parseUiautomator(xml, { filter: o.filter, query: o.query, screen })
      session.elements = elements
      const fg = dumpPackage(xml)
      return { header: `Foreground package: ${fg ?? '?'}.`, elements }
    }
    const win = await resolveWindow(env, o.window, signal)
    if (win.minimized)
      throw new EnvError('EINVAL', `window ${JSON.stringify(win.title)} is minimized; restore it first`)
    const { elements, truncated } = await listUia(env, win, { filter: o.filter, query: o.query, signal })
    session.elements = elements
    return {
      header: `Window hwnd=${win.hwnd} ${JSON.stringify(win.title)} (${win.process}).${truncated ? ' The tree was truncated; narrow it with query.' : ''}`,
      elements,
      window: win,
    }
  }

  /** The element an action targets: index from the latest listing, or the first match of `match`. */
  const target = async (
    args: { element?: number | undefined; match?: string | undefined; window?: string | undefined },
    signal?: AbortSignal,
  ): Promise<UiElement> => {
    if (args.element !== undefined) return session.element(args.element)
    if (!args.match)
      throw new EnvError('EINVAL', 'give element (index from the latest listing) or match (text to find)')
    const { elements } = await list({ filter: 'default', query: args.match, window: args.window }, signal)
    const needle = args.match.toLowerCase()
    const exact = elements.find(e => [e.text, e.desc, e.id].some(v => v?.toLowerCase() === needle))
    const found = exact ?? elements[0]
    if (!found) throw new EnvError('ENOENT', `no element matches ${JSON.stringify(args.match)}`)
    return found
  }

  const run = (acts: InputActionFields[], signal?: AbortSignal) => env.input(acts, { signal })

  const actions = android ? ANDROID_ACTIONS : WINDOWS_ACTIONS
  add({
    name: 'ui',
    description: android
      ? `List the on-screen UI elements of ${name} (Android accessibility tree via uiautomator) or act on one. "list" returns lines like '[3] Button "OK" #ok_button @(540,1200) 200x96 [clickable]': index, class, text/description, resource id, centre and size in the latest screenshot's pixels, and flags. Act with action click / long_press / set_text (focus, clear and type text) / scroll (direction) on element: N, or match: "text" to find the element by text, description or resource id. Prefer this over guessing coordinates from screenshots; element indexes are also accepted by ${a}__input.`
      : `List the UI Automation elements of a window on ${name} (default: the foreground window) or act on one. "list" returns lines like '[3] Button "Save" #saveBtn @(512,300) 90x32 [invoke]': index, control type, name, automation id, centre and size in the latest screenshot's pixels, and supported patterns/states. click uses the Invoke/Toggle/Select pattern when available (works even if covered) and otherwise clicks the centre; set_text sets the value directly (or focuses and types); also double_click, right_click, focus, toggle, expand, collapse, select, scroll_into_view, scroll (direction). Target with element: N from the latest listing or match: "text". Apps without UI Automation support (some games, custom-drawn or old Win32/WinForms apps) show few elements; use screenshots there.`,
    parameters: {
      action: { type: 'string', enum: actions, description: 'Default list.' },
      element: { type: 'integer', description: 'Element index from the latest listing.' },
      match: {
        type: 'string',
        description: 'Find the target by text / description / id (case-insensitive substring).',
      },
      text: { type: 'string', description: 'set_text: the new text.' },
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'scroll: content direction to reveal.',
      },
      amount: {
        type: 'number',
        description: 'scroll: how far (default 5 ≈ half a screen on Android, 5 wheel notches on Windows).',
      },
      filter: {
        type: 'string',
        enum: ['default', 'interactive', 'all'],
        description:
          'list: default = interactive or labelled elements; interactive = actionable only; all = every node (indented by depth).',
      },
      query: { type: 'string', description: 'list: only elements whose text/description/id contains this.' },
      ...(uia
        ? {
            window: {
              type: 'string',
              description: 'Window title substring, process name or hwnd (default foreground).',
            },
          }
        : {}),
      ...(android ? { raw: { type: 'boolean', description: 'list: return the raw uiautomator XML.' } } : {}),
      screenshot: { type: 'boolean', description: 'After an action, return a fresh screenshot.' },
    },
    output: IMAGE_OUTPUT,
    timeoutMs: 120000,
    async execute(args, exec): Promise<ImageValue> {
      const signal = exec.signal
      const action = args.action ?? 'list'
      const windowSel = 'window' in args && typeof args.window === 'string' ? args.window : undefined
      if (action === 'list') {
        const raw = 'raw' in args && args.raw === true
        const res = await list({ filter: args.filter, query: args.query, window: windowSel, raw }, signal)
        if (res.raw !== undefined) return { text: clip(res.raw) }
        const frame = await session.ensureFrame(signal)
        const lines = res.elements.map(e => formatElement(e, frame))
        return {
          text: clip(
            `${res.header} ${res.elements.length} element${res.elements.length === 1 ? '' : 's'}; coordinates are pixels of the latest screenshot (${frame.width}x${frame.height}).\n${lines.join('\n') || '(no matching elements)'}`,
          ),
        }
      }
      const el = await target({ element: args.element, match: args.match, window: windowSel }, signal)
      const c = center(el.bounds)
      let note = ''
      if (android) {
        switch (action) {
          case 'click':
            await run([{ kind: 'tap', x: c.x, y: c.y }], signal)
            break
          case 'long_press':
            await run([{ kind: 'long_press', x: c.x, y: c.y }], signal)
            break
          case 'set_text': {
            await run([{ kind: 'tap', x: c.x, y: c.y }], signal)
            await sleep(300)
            const sdk = android.android?.sdk ?? 0
            const clear =
              sdk >= 33
                ? `${keyCommand('ctrl+a')}; input keyevent 67`
                : `input keyevent 123; ${keyCommand('del', { repeat: Math.min(200, (el.text?.length ?? 0) + 5) })}`
            if (el.text || sdk < 33) await android.check(clear, { signal })
            await android.typeText(args.text ?? '', { signal })
            break
          }
          case 'scroll':
            await run([scrollAction(el, args.direction, args.amount ?? 5)], signal)
            break
          default:
            throw new EnvError('EINVAL', `unsupported action ${action}`)
        }
      } else {
        const focusWin = async () => {
          if (el.ref?.hwnd) await env.windowAction(el.ref.hwnd, 'focus', undefined, { signal }).catch(() => undefined)
        }
        switch (action) {
          case 'click': {
            const { used } = await actUia(env, el, 'click', undefined, signal)
            if (used === 'mouse') {
              await focusWin()
              await run([{ kind: 'click', x: c.x, y: c.y }], signal)
            }
            note = used === 'mouse' ? 'clicked the centre with the mouse' : `used the ${used} pattern`
            break
          }
          case 'double_click':
          case 'right_click':
            await focusWin()
            await run(
              [
                action === 'double_click'
                  ? { kind: 'click', x: c.x, y: c.y, count: 2 }
                  : { kind: 'click', x: c.x, y: c.y, button: 'right' },
              ],
              signal,
            )
            break
          case 'set_text': {
            const { used } = await actUia(env, el, 'set_text', args.text ?? '', signal)
            if (used !== 'value') {
              await focusWin()
              await run(
                [
                  { kind: 'click', x: c.x, y: c.y },
                  { kind: 'key', key: 'ctrl+a' },
                  { kind: 'type', text: args.text ?? '' },
                ],
                signal,
              )
              note = 'no settable value: clicked, selected all and typed'
            } else note = 'set via the Value pattern'
            break
          }
          case 'scroll':
            await run([scrollAction(el, args.direction, args.amount ?? 5, true)], signal)
            break
          default: {
            const { used } = await actUia(env, el, action as UiaAction, undefined, signal)
            note = `used ${used}`
          }
        }
      }
      const done = `${action} on [${el.index}] ${el.role}${el.text ? ` ${JSON.stringify(el.text)}` : ''}${note ? ` (${note})` : ''}. Element indexes may be stale now; list again before using them.`
      if (!args.screenshot) return { text: done }
      await sleep(500)
      return screenshotValue(ctx, exec, session, a, await followUpShot(session, signal), done)
    },
  })
}

/** Scroll gesture inside an element (physical coordinates). */
function scrollAction(el: UiElement, direction: string | undefined, amount: number, wheel = false): InputActionFields {
  const c = center(el.bounds)
  const n = Math.max(0.5, Math.min(20, amount))
  const dir = direction ?? 'down'
  if (wheel) {
    return {
      kind: 'scroll',
      x: Math.round(c.x),
      y: Math.round(c.y),
      dy: dir === 'down' ? n : dir === 'up' ? -n : 0,
      dx: dir === 'right' ? n : dir === 'left' ? -n : 0,
    }
  }
  // Android: swipe across up to 80% of the element along the axis.
  const vertical = dir === 'up' || dir === 'down'
  const span = (vertical ? el.bounds.height : el.bounds.width) * Math.min(0.8, n * 0.16)
  const sign = dir === 'down' || dir === 'right' ? 1 : -1
  const from = vertical ? { x: c.x, y: c.y + (sign * span) / 2 } : { x: c.x + (sign * span) / 2, y: c.y }
  const to = vertical ? { x: c.x, y: c.y - (sign * span) / 2 } : { x: c.x - (sign * span) / 2, y: c.y }
  return {
    kind: 'swipe',
    x: Math.round(from.x),
    y: Math.round(from.y),
    x2: Math.round(to.x),
    y2: Math.round(to.y),
    durationMs: 450,
  }
}
