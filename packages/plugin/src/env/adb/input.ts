// Translate input actions into Android `input` shell commands (pure functions, unit-tested).
import { EnvError } from '@dsh-environments/protocol'
import type { InputActionFields } from '../types.ts'
import { androidKey } from './keys.ts'

export interface AndroidScreen {
  width: number
  height: number
}

const r = (n: number | undefined) => Math.round(n ?? NaN)

function need(a: InputActionFields, ...keys: ('x' | 'y' | 'x2' | 'y2')[]): void {
  for (const k of keys) {
    if (a[k] === undefined || !Number.isFinite(a[k])) throw new EnvError('EINVAL', `${a.kind} needs ${keys.join(', ')}`)
  }
}

/** True when `input text` can type the string (printable ASCII plus newline/tab handled as keys). */
export function isAsciiTypable(text: string): boolean {
  return /^[\x20-\x7e\n\r\t]*$/.test(text)
}

/** Single-quote for the device shell. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Commands that type ASCII text with `input text`. Spaces become `%s`; a literal `%s` is split
 * across two commands so it is not turned into a space; newlines and tabs become key events.
 */
export function inputTextCommands(text: string, chunk = 200): string[] {
  const out: string[] = []
  let cur = ''
  const flush = () => {
    if (cur) out.push(`input text ${shq(cur.replace(/ /g, '%s'))}`)
    cur = ''
  }
  const t = text.replace(/\r\n?/g, '\n')
  for (let i = 0; i < t.length; i++) {
    const c = t[i] ?? ''
    if (c === '\n' || c === '\t') {
      flush()
      out.push(`input keyevent ${c === '\n' ? 66 : 61}`)
      continue
    }
    cur += c
    if ((c === '%' && t[i + 1] === 's') || cur.length >= chunk) flush()
  }
  flush()
  return out
}

/** `input keyevent` / `input keycombination` for a combo such as "ctrl+a" or "home". */
export function keyCommand(
  combo: string,
  { repeat = 1, holdMs = 0 }: { repeat?: number; holdMs?: number } = {},
): string {
  const parts = combo
    .split('+')
    .map(p => p.trim())
    .filter(Boolean)
  if (parts.length === 0) throw new EnvError('EINVAL', 'empty key')
  if (parts.length > 1) {
    const codes = parts.map(p => androidKey(p))
    const one = `input keycombination ${codes.join(' ')}`
    return Array<string>(Math.min(50, Math.max(1, repeat)))
      .fill(one)
      .join('; ')
  }
  const code = androidKey(parts[0])
  if (holdMs > 0) return `input keyevent --longpress ${code}`
  return `input keyevent ${Array<string | number>(Math.min(100, Math.max(1, repeat)))
    .fill(code)
    .join(' ')}`
}

/**
 * Shell script for one non-text, non-wait action. Coordinates are physical screen pixels.
 * `screen` sizes scroll gestures.
 */
export function actionScript(a: InputActionFields, screen: AndroidScreen): string {
  switch (a.kind) {
    case 'click':
    case 'tap': {
      need(a, 'x', 'y')
      const at = `${r(a.x)} ${r(a.y)}`
      if (a.long || a.button === 'right') return `input swipe ${at} ${at} ${r(a.holdMs ?? a.durationMs ?? 800)}`
      const count = a.count ?? (a.double ? 2 : 1)
      if (count <= 1) return `input tap ${at}`
      // Each `input` invocation takes ~150-300 ms to start; overlapping them keeps the taps
      // inside the double-tap timeout.
      return `${Array<string>(count - 1)
        .fill(`input tap ${at} & sleep 0.12;`)
        .join(' ')} input tap ${at}; wait`
    }
    case 'long_press':
      need(a, 'x', 'y')
      return `input swipe ${r(a.x)} ${r(a.y)} ${r(a.x)} ${r(a.y)} ${r(a.durationMs ?? a.holdMs ?? a.ms ?? 800)}`
    case 'swipe': {
      const path = a.path
      if (path && path.length >= 2) return pathScript(path, a.durationMs ?? 300)
      need(a, 'x', 'y', 'x2', 'y2')
      return `input swipe ${r(a.x)} ${r(a.y)} ${r(a.x2)} ${r(a.y2)} ${r(a.durationMs ?? a.ms ?? 300)}`
    }
    case 'drag': {
      const path =
        a.path ??
        (a.x2 !== undefined
          ? ([
              [a.x ?? 0, a.y ?? 0],
              [a.x2, a.y2 ?? 0],
            ] as const)
          : undefined)
      if (!path || path.length < 2) throw new EnvError('EINVAL', 'drag needs a path of at least two points')
      const dur = r(a.durationMs ?? a.ms ?? 800)
      const [p0, p1] = [path[0], path[path.length - 1]]
      if (path.length === 2 && p0 && p1) {
        // draganddrop long-presses first, which drag-and-drop targets (icons, list items) need.
        return a.holdMs === 0
          ? `input swipe ${r(p0[0])} ${r(p0[1])} ${r(p1[0])} ${r(p1[1])} ${dur}`
          : `input draganddrop ${r(p0[0])} ${r(p0[1])} ${r(p1[0])} ${r(p1[1])} ${dur}`
      }
      return pathScript(path, dur)
    }
    case 'scroll': {
      const x = r(a.x ?? screen.width / 2)
      const y = r(a.y ?? screen.height / 2)
      // One notch ≈ 10% of the screen; positive dy scrolls down (finger moves up).
      const dy = (a.dy ?? 0) * screen.height * 0.1
      const dx = (a.dx ?? 0) * screen.width * 0.1
      const clampX = (v: number) => r(Math.min(screen.width * 0.95, Math.max(screen.width * 0.05, v)))
      const clampY = (v: number) => r(Math.min(screen.height * 0.95, Math.max(screen.height * 0.05, v)))
      if (!dx && !dy) throw new EnvError('EINVAL', 'scroll needs dx or dy')
      return `input swipe ${clampX(x + dx / 2)} ${clampY(y + dy / 2)} ${clampX(x - dx / 2)} ${clampY(y - dy / 2)} ${r(a.durationMs ?? 450)}`
    }
    case 'key':
      if (!a.key) throw new EnvError('EINVAL', 'key needs `key`')
      return keyCommand(a.key, { repeat: a.repeat, holdMs: a.holdMs })
    case 'move':
    case 'mouse_down':
    case 'mouse_up':
    case 'key_down':
    case 'key_up':
      throw new EnvError(
        'UNSUPPORTED',
        `${a.kind} is not available on Android (touch screens have no hover or held keys); use click, long_press, swipe or drag`,
      )
    default:
      throw new EnvError('EINVAL', `unsupported input action ${a.kind}`)
  }
}

/** Press, move through every point, release (`input motionevent`). */
function pathScript(path: readonly (readonly [number, number])[], durationMs: number): string {
  const pause = Math.max(0, durationMs / Math.max(1, path.length - 1) / 1000).toFixed(3)
  const [first, ...rest] = path
  const last = rest[rest.length - 1] ?? first
  const lines = [`input motionevent DOWN ${r(first?.[0])} ${r(first?.[1])}`]
  for (const p of rest) lines.push(`sleep ${pause}`, `input motionevent MOVE ${r(p[0])} ${r(p[1])}`)
  lines.push(`input motionevent UP ${r(last?.[0])} ${r(last?.[1])}`)
  return lines.join('; ')
}
