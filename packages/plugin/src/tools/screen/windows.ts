// Find a top-level window by handle, title or process name.
import { EnvError } from '@dsh-environments/protocol'
import type { Environment } from '../../env/environment.ts'
import type { WindowInfo } from '../../env/types.ts'
import { type Frame, rectToImage } from './session.ts'

/**
 * Resolve a window selector: a handle ("hwnd" number or "0x..."), or a case-insensitive
 * substring of the title or the process name. Without a selector, the foreground window.
 */
export async function resolveWindow(
  env: Environment,
  selector: string | number | undefined,
  signal?: AbortSignal,
): Promise<WindowInfo> {
  const list = await env.windows({ signal })
  const sel = typeof selector === 'string' ? selector.trim() : selector
  if (sel === undefined || sel === '') {
    const fg = list.find(w => w.foreground)
    if (!fg) throw new EnvError('ENOENT', 'no foreground window; name a window')
    return fg
  }
  const asNum = typeof sel === 'number' ? sel : /^(0x[0-9a-f]+|\d+)$/i.test(sel) ? Number(sel) : undefined
  if (asNum !== undefined) {
    const w = list.find(x => x.hwnd === asNum)
    if (w) return w
    if (typeof sel === 'number') throw new EnvError('ENOENT', `no window with handle ${sel}`)
  }
  const needle = String(sel).toLowerCase()
  const matches = list.filter(
    w =>
      w.title.toLowerCase().includes(needle) ||
      w.process.toLowerCase().replace(/\.exe$/, '') === needle.replace(/\.exe$/, ''),
  )
  // Prefer an exact title, then the topmost (z-order) match.
  const exact = matches.find(w => w.title.toLowerCase() === needle)
  const found = exact ?? matches[0]
  if (!found) {
    throw new EnvError(
      'ENOENT',
      `no window matches ${JSON.stringify(sel)}. Open windows: ${list
        .slice(0, 15)
        .map(w => JSON.stringify(w.title))
        .join(', ')}`,
    )
  }
  return found
}

/** One line per window; rectangles in frame coordinates when a frame exists. */
export function formatWindow(w: WindowInfo, f: Frame | undefined): string {
  const r = f ? rectToImage(f, w) : w
  const flags = [
    w.foreground ? 'foreground' : '',
    w.minimized ? 'minimized' : '',
    w.maximized ? 'maximized' : '',
    w.topmost ? 'topmost' : '',
  ].filter(Boolean)
  return `hwnd=${w.hwnd} ${JSON.stringify(w.title)} ${w.process || '?'} (pid ${w.pid}) at (${r.x},${r.y}) ${r.width}x${r.height}${flags.length ? ` [${flags.join(', ')}]` : ''}`
}
