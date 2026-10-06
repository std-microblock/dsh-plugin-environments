// Parse `uiautomator dump` XML into compact UI elements for the model.
import type { PixelRect } from '@dsh-environments/protocol'
import type { UiElement } from './session.ts'

interface RawNode {
  attrs: Record<string, string>
  depth: number
  parent: number
  children: number[]
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e] ?? m
  })
}

function parseBounds(b: string | undefined): PixelRect | undefined {
  const m = b && /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b)
  if (!m) return undefined
  const [x0, y0, x1, y1] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number]
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

function parseNodes(xml: string): RawNode[] {
  const nodes: RawNode[] = []
  const stack: number[] = []
  const re = /<node\b([^>]*?)(\/?)>|<\/node>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    if (m[0] === '</node>') {
      stack.pop()
      continue
    }
    const attrs: Record<string, string> = {}
    for (const [, key, value] of (m[1] ?? '').matchAll(/([\w:-]+)="([^"]*)"/g)) {
      if (key) attrs[key] = decodeXml(value ?? '')
    }
    const parent = stack[stack.length - 1] ?? -1
    const idx = nodes.length
    nodes.push({ attrs, depth: stack.length, parent, children: [] })
    if (parent >= 0) nodes[parent]?.children.push(idx)
    if (m[2] !== '/') stack.push(idx)
  }
  return nodes
}

export type UiFilter = 'default' | 'interactive' | 'all'

export interface AndroidUiOptions {
  filter?: UiFilter | undefined
  /** Case-insensitive substring of text, content-desc or resource id. */
  query?: string | undefined
  /** Screen size used to drop off-screen nodes. */
  screen?: { width: number; height: number } | undefined
  limit?: number | undefined
}

/** Elements of a uiautomator dump, filtered and indexed from 0. */
export function parseUiautomator(xml: string, opts: AndroidUiOptions = {}): UiElement[] {
  const nodes = parseNodes(xml)
  const filter = opts.filter ?? 'default'
  const query = opts.query?.toLowerCase()
  const absorbed = new Set<number>()
  const labelOf = (i: number): string => {
    const n = nodes[i]
    return (n?.attrs['text'] || n?.attrs['content-desc'] || '').trim()
  }
  const interactive = (a: Record<string, string>) =>
    a['clickable'] === 'true' ||
    a['long-clickable'] === 'true' ||
    a['scrollable'] === 'true' ||
    a['checkable'] === 'true' ||
    /EditText|AutoCompleteTextView/.test(a['class'] ?? '')
  // Inherit labels for unlabelled interactive containers (e.g. a clickable row holding a TextView).
  const inherited = new Map<number, string>()
  nodes.forEach((n, i) => {
    // Scrollable containers would swallow their whole content; only label rows and buttons.
    if (!interactive(n.attrs) || labelOf(i) || n.attrs['scrollable'] === 'true') return
    const texts: string[] = []
    const walk = (j: number) => {
      for (const c of nodes[j]?.children ?? []) {
        const child = nodes[c]
        if (!child || texts.length >= 3) return
        if (interactive(child.attrs) && child.attrs['scrollable'] !== 'true' && labelOf(c)) continue
        const l = labelOf(c)
        if (l) {
          texts.push(l)
          absorbed.add(c)
        }
        walk(c)
      }
    }
    walk(i)
    if (texts.length) inherited.set(i, texts.join(' | '))
  })
  const out: UiElement[] = []
  const limit = opts.limit ?? 400
  nodes.forEach((n, i) => {
    const a = n.attrs
    const bounds = parseBounds(a['bounds'])
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return
    if (
      opts.screen &&
      (bounds.x >= opts.screen.width ||
        bounds.y >= opts.screen.height ||
        bounds.x + bounds.width <= 0 ||
        bounds.y + bounds.height <= 0)
    )
      return
    const text = (a['text'] ?? '').trim() || inherited.get(i)
    const desc = (a['content-desc'] ?? '').trim() || undefined
    const id = a['resource-id'] ? a['resource-id'].replace(/^[\w.]+:id\//, '') : undefined
    const isInteractive = interactive(a)
    if (filter === 'interactive' && !isInteractive) return
    if (filter === 'default' && !isInteractive && (!(text || desc) || absorbed.has(i))) return
    if (query) {
      const hay = `${text ?? ''}\n${desc ?? ''}\n${a['resource-id'] ?? ''}`.toLowerCase()
      if (!hay.includes(query)) return
    }
    const flags: string[] = []
    if (a['clickable'] === 'true') flags.push('clickable')
    if (a['long-clickable'] === 'true') flags.push('long-clickable')
    if (a['scrollable'] === 'true') flags.push('scrollable')
    if (/EditText|AutoCompleteTextView/.test(a['class'] ?? '')) flags.push('editable')
    if (a['checkable'] === 'true') flags.push(a['checked'] === 'true' ? 'checked' : 'unchecked')
    if (a['selected'] === 'true') flags.push('selected')
    if (a['focused'] === 'true') flags.push('focused')
    if (a['password'] === 'true') flags.push('password')
    if (a['enabled'] === 'false') flags.push('disabled')
    if (out.length >= limit) return
    out.push({
      index: out.length,
      depth: filter === 'all' ? n.depth : 0,
      role: (a['class'] ?? 'node').split('.').pop() || 'node',
      text: text || undefined,
      desc,
      id,
      bounds,
      flags,
      ...(a['hint'] && a['hint'] !== text ? { value: `hint: ${a['hint']}` } : {}),
    })
  })
  return out
}

/** The foreground package recorded in the dump (first node's package). */
export function dumpPackage(xml: string): string | undefined {
  return /<node\b[^>]*\bpackage="([^"]*)"/.exec(xml)?.[1]
}
