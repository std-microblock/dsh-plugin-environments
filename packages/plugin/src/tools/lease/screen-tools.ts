// Computer use: screenshots and pointer/keyboard input of a borrowed environment.
//
// Coordinates exchanged with the model are always pixels of the latest screenshot image
// (see ScreenSession); they are mapped to physical pixels here.
import { EnvError } from '@dsh-environments/protocol'
import type { Environment } from '../../env/environment.ts'
import type { InputActionFields } from '../../env/types.ts'
import { IMAGE_OUTPUT, imageValue, type ImageExec, type ImageValue } from '../image.ts'
import { DEFAULT_MAX_EDGE, describeFrame, mapAction, type ScreenSession, type ShotOptions } from '../screen/session.ts'
import { resolveWindow } from '../screen/windows.ts'
import type { PluginContext } from '../../host-api.ts'
import type { LeaseToolContext } from './context.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Take a screenshot and build the image tool value, prefixed with `before`. */
export async function screenshotValue(
  ctx: PluginContext,
  exec: ImageExec,
  session: ScreenSession,
  alias: string,
  opts: ShotOptions,
  before = '',
): Promise<ImageValue> {
  const shot = await session.shoot({ ...opts, signal: exec.signal })
  let text = `${before}${before ? '\n' : ''}${describeFrame(shot.frame, shot.rect)}`
  if (shot.cursor) text += `\nMouse pointer at (${Math.round(shot.cursor.x)},${Math.round(shot.cursor.y)}).`
  if (shot.frame.kind === 'screen' && session.env.hasCap('displays')) {
    const displays = await session.env.displays({ signal: exec.signal }).catch(() => [])
    if (displays.length > 1) {
      text += `\nDisplays: ${displays
        .map(d => `${d.index}${d.primary ? ' (primary)' : ''} ${d.width}x${d.height} at ${d.x},${d.y}`)
        .join('; ')}. Pick one with display=N.`
    }
  }
  return imageValue(ctx, exec, shot.data, {
    name: `${alias}-screenshot.${shot.mediaType === 'image/jpeg' ? 'jpg' : 'png'}`,
    text,
    mediaType: shot.mediaType,
  })
}

/** Screenshot options that re-capture what the latest screenshot showed (window or display). */
export async function followUpShot(session: ScreenSession, signal?: AbortSignal): Promise<ShotOptions> {
  if (session.window && session.env.hasCap('windows')) {
    const w = await resolveWindow(session.env, session.window.hwnd, signal).catch(() => undefined)
    if (w && !w.minimized) return { window: w }
  }
  return {}
}

export interface ModelInputAction {
  kind: string
  x?: number | undefined
  y?: number | undefined
  x2?: number | undefined
  y2?: number | undefined
  element?: number | undefined
  path?: number[][] | undefined
  button?: 'left' | 'right' | 'middle' | undefined
  count?: number | undefined
  modifiers?: string | undefined
  dx?: number | undefined
  dy?: number | undefined
  text?: string | undefined
  key?: string | undefined
  repeat?: number | undefined
  hold_ms?: number | undefined
  duration_ms?: number | undefined
  ms?: number | undefined
}

/** Model-facing action (screenshot coordinates, snake_case) → environment actions (physical). */
export async function toEnvActions(
  session: ScreenSession,
  actions: readonly ModelInputAction[],
  signal?: AbortSignal,
): Promise<InputActionFields[]> {
  const android = session.env.kind === 'adb'
  const out: InputActionFields[] = []
  for (const a of actions) {
    const path = a.path?.map(p => {
      if (p.length !== 2 || !p.every(n => Number.isFinite(n)))
        throw new EnvError('EINVAL', 'path points must be [x, y]')
      return [p[0] ?? 0, p[1] ?? 0] as const
    })
    const base: InputActionFields & { element?: number | undefined } = {
      kind: a.kind as InputActionFields['kind'],
      x: a.x,
      y: a.y,
      x2: a.x2,
      y2: a.y2,
      element: a.element,
      path,
      button: a.button,
      count: a.count,
      modifiers: a.modifiers,
      dx: a.dx,
      dy: a.dy,
      text: a.text,
      key: a.key,
      repeat: a.repeat,
      holdMs: a.hold_ms,
      durationMs: a.duration_ms,
      ms: a.ms,
    }
    for (const k of Object.keys(base) as (keyof typeof base)[]) if (base[k] === undefined) delete base[k]
    const m = await mapAction(session, base, signal)
    if (a.kind === 'type' && (a.element !== undefined || (a.x !== undefined && a.y !== undefined))) {
      // Typing "into" a target: focus it first.
      out.push({ kind: 'click', x: m.x, y: m.y })
      out.push({ kind: 'wait', ms: android ? 300 : 120 })
      out.push({ kind: 'type', text: a.text ?? '' })
      continue
    }
    if (!android && a.kind === 'long_press') {
      out.push({ kind: 'mouse_down', x: m.x, y: m.y, button: m.button })
      out.push({ kind: 'wait', ms: Math.min(10000, a.duration_ms ?? a.hold_ms ?? a.ms ?? 800) })
      out.push({ kind: 'mouse_up', x: m.x, y: m.y, button: m.button })
      continue
    }
    if (!android && (a.kind === 'drag' || a.kind === 'swipe') && !m.path && m.x2 !== undefined) {
      m.path = [
        [m.x ?? 0, m.y ?? 0],
        [m.x2, m.y2 ?? 0],
      ]
    }
    if (android && (a.kind === 'click' || a.kind === 'long_press') && (m.x === undefined || m.y === undefined))
      throw new EnvError('EINVAL', `${a.kind} needs x and y (or element)`)
    out.push(m)
  }
  return out
}

function inputDescription(env: Environment, a: string, name: string): string {
  if (env.kind === 'adb') {
    return [
      `Touch and key input on ${name} (Android). Actions run in order. x/y are pixels of the latest screenshot image (${a}__screenshot, ${a}__ui or a screenshot returned by this tool); instead of x/y you can pass element: N to target [N] of the latest ${a}__ui listing.`,
      'Kinds: click {x,y,count?} taps (count 2 = double tap); long_press {x,y,duration_ms?}; swipe {x,y,x2,y2,duration_ms?} for scrolling/flinging/sliders; drag {x,y,x2,y2 or path:[[x,y],...]} press-and-hold then move (rearrange, drag-and-drop);',
      'scroll {x?,y?,dy} (+1 ≈ 10% of the screen; positive scrolls down/reveals content below; dx for horizontal); type {text} into the focused field (element/x,y taps it first; newline = Enter; non-ASCII is pasted from the device clipboard, so the field must allow pasting);',
      'key {key, repeat?} — names: back, home, recents, enter, del (backspace), tab, escape, up/down/left/right, power, wakeup, volume_up, menu, search, paste, a-z, 0-9, KEYCODE_* or a numeric code; combos like "ctrl+a" use keycombination;',
      'wait {ms}. Set screenshot: true to get a fresh screenshot after the actions instead of calling the screenshot tool.',
    ].join(' ')
  }
  return [
    `Mouse and keyboard input on ${name}. Actions run in order. x/y are pixels of the latest screenshot image (${a}__screenshot, ${a}__ui or a screenshot returned by this tool); instead of x/y you can pass element: N to target [N] of the latest ${a}__ui listing.`,
    'Kinds: click {x,y,button?,count?,modifiers?} (count 2 = double click; modifiers like "ctrl" or "shift+alt" are held during the click); move {x,y}; drag {x,y,x2,y2 or path:[[x,y],...], duration_ms?} (press, move, release); long_press {x,y,duration_ms?};',
    'scroll {x,y,dy,dx?} in wheel notches (≈3 lines each; positive dy scrolls down); type {text} any Unicode text, \\n = Enter (element/x,y clicks the target first);',
    'key {key, repeat?, hold_ms?} — combos like "ctrl+s", "alt+tab", "ctrl+shift+esc", "win+r", or single keys: enter, esc, tab, backspace, delete, home, end, pageup, pagedown, up, down, left, right, f1-f24, space, a-z, 0-9;',
    'key_down/key_up {key} hold keys across actions (anything still held is released when the call ends); mouse_down/mouse_up {x?,y?,button?}; wait {ms}.',
    'Set screenshot: true to get a fresh screenshot after the actions (waits settle_ms first) instead of calling the screenshot tool.',
  ].join(' ')
}

export function addScreenTools(
  { ctx, env, alias: a, label: name, add }: LeaseToolContext,
  session: ScreenSession,
): void {
  const windowsCaps = env.hasCap('windows')
  const displayCaps = env.hasCap('displays')
  if (env.hasCap('screenshot')) {
    add({
      name: 'screenshot',
      description: [
        `Capture the screen of ${name}. The image is downscaled so its long edge is at most max_size (default ${DEFAULT_MAX_EDGE}); all x/y in ${a}__input, ${a}__ui${windowsCaps ? ` and ${a}__windows` : ''} then refer to pixels of THIS image (the scaling is handled for you).`,
        'Use region to zoom into part of the current image (coordinates of the current image; up to 2x magnification) when text is too small; the zoomed image becomes the coordinate frame until the next screenshot.',
        windowsCaps ? 'window captures one window (even when covered) by title, process name or hwnd.' : '',
        displayCaps ? 'display picks a monitor on multi-monitor systems (0 = primary, -1 = all).' : '',
      ]
        .filter(Boolean)
        .join(' '),
      parameters: {
        region: {
          type: 'object',
          additionalProperties: false,
          description: 'Zoom: rectangle in the current screenshot coordinates.',
          properties: {
            x: { type: 'number', required: true },
            y: { type: 'number', required: true },
            width: { type: 'number', required: true },
            height: { type: 'number', required: true },
          },
        },
        ...(windowsCaps
          ? {
              window: {
                type: 'string',
                description: 'Capture only this window: title substring, process name or hwnd.',
              },
            }
          : {}),
        ...(displayCaps
          ? {
              display: {
                type: 'integer',
                description: 'Monitor index (0 = primary, -1 = all monitors); remembered for later screenshots.',
              },
            }
          : {}),
        max_size: {
          type: 'integer',
          description: `Long-edge limit in pixels, 256-2048 (default ${DEFAULT_MAX_EDGE}; remembered).`,
        },
        format: {
          type: 'string',
          enum: ['auto', 'png', 'jpeg'],
          description: 'auto (default): PNG for UI, JPEG when the PNG would be large (photos, video).',
        },
        quality: { type: 'integer', description: 'JPEG quality 30-95 (default 80).' },
        ...(windowsCaps ? { cursor: { type: 'boolean', description: 'Draw the mouse pointer into the image.' } } : {}),
      },
      output: IMAGE_OUTPUT,
      async execute(args, exec) {
        const window =
          'window' in args && typeof args.window === 'string' && args.window
            ? await resolveWindow(env, args.window, exec.signal)
            : undefined
        if (window?.minimized) throw new Error(`window ${JSON.stringify(window.title)} is minimized; restore it first`)
        return screenshotValue(ctx, exec, session, a, {
          region: args.region,
          window,
          display: 'display' in args && typeof args.display === 'number' ? args.display : undefined,
          maxEdge: args.max_size,
          format: args.format,
          quality: args.quality === undefined ? undefined : Math.min(95, Math.max(30, args.quality)),
          cursor: 'cursor' in args && args.cursor === true,
        })
      },
    })
  }

  if (env.hasCap('input')) {
    const android = env.kind === 'adb'
    const kinds = android
      ? ['click', 'long_press', 'swipe', 'drag', 'scroll', 'type', 'key', 'wait']
      : [
          'click',
          'move',
          'drag',
          'long_press',
          'scroll',
          'type',
          'key',
          'key_down',
          'key_up',
          'mouse_down',
          'mouse_up',
          'wait',
        ]
    add({
      name: 'input',
      description: inputDescription(env, a, name),
      parameters: {
        actions: {
          type: 'array',
          required: true,
          description: 'Actions to perform in order.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: kinds, required: true },
              x: { type: 'number' },
              y: { type: 'number' },
              element: {
                type: 'integer',
                description: `Index of an element from the latest ${a}__ui listing (instead of x/y).`,
              },
              x2: { type: 'number', description: 'End point of a swipe/drag.' },
              y2: { type: 'number' },
              path: {
                type: 'array',
                description: 'Drag path [[x,y], ...] (at least two points).',
                items: { type: 'array', items: { type: 'number' } },
              },
              ...(android
                ? {}
                : {
                    button: { type: 'string', enum: ['left', 'right', 'middle'] },
                    modifiers: {
                      type: 'string',
                      description: 'Keys held during click/drag/scroll, e.g. "ctrl+shift".',
                    },
                  }),
              count: { type: 'integer', description: 'Clicks/taps (2 = double).' },
              dx: { type: 'number', description: 'Horizontal scroll (positive = right).' },
              dy: { type: 'number', description: 'Vertical scroll (positive = down).' },
              text: { type: 'string' },
              key: { type: 'string' },
              repeat: { type: 'integer', description: 'Press the key this many times.' },
              hold_ms: { type: 'integer', description: 'Hold the key / press this long.' },
              duration_ms: { type: 'integer', description: 'Gesture duration.' },
              ms: { type: 'integer', description: 'wait: milliseconds.' },
            },
          },
        },
        screenshot: { type: 'boolean', description: 'Return a screenshot after the actions.' },
        settle_ms: { type: 'integer', description: 'Wait before that screenshot (default 500).' },
      },
      output: IMAGE_OUTPUT,
      async execute(args, exec) {
        const acts = await toEnvActions(session, args.actions as ModelInputAction[], exec.signal)
        await env.input(acts, { signal: exec.signal })
        const n = args.actions.length
        const done = `Performed ${n} action${n === 1 ? '' : 's'}.`
        if (!args.screenshot) return { text: done }
        await sleep(Math.min(10000, Math.max(0, args.settle_ms ?? 500)))
        return screenshotValue(ctx, exec, session, a, await followUpShot(session, exec.signal), done)
      },
    })
  }
}
