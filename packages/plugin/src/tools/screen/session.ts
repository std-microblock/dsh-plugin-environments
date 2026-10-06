// Per-lease computer-use state: the coordinate frame of the latest screenshot, the selected
// display/window, and the UI elements of the latest `ui` listing.
//
// Rule exposed to the model: every x/y in tool arguments and results is a pixel position in
// the most recent screenshot image. Internally that maps affinely to physical pixels.
import { EnvError, type PixelRect } from '@dsh-environments/protocol'
import type { Environment } from '../../env/environment.ts'
import type { InputActionFields, WindowInfo } from '../../env/types.ts'
import {
  crop,
  decodePng,
  encodeImage,
  fitSize,
  isPng,
  type EncodedImage,
  type ImageFormat,
  type RgbImage,
  resize,
} from '../../image/codec.ts'

/** How image pixels of the latest screenshot map to physical pixels. */
export interface Frame {
  /** Physical position of the image's top-left corner. */
  x: number
  y: number
  /** Image pixels per physical pixel, per axis. */
  sx: number
  sy: number
  /** Image size. */
  width: number
  height: number
  kind: 'screen' | 'window' | 'region'
  display?: number | undefined
  window?: WindowInfo | undefined
}

export interface Point {
  x: number
  y: number
}

/** Image coordinates → physical pixels (pixel centres map to pixel centres). */
export function toPhysical(f: Frame, x: number, y: number): Point {
  return { x: f.x + (x + 0.5) / f.sx - 0.5, y: f.y + (y + 0.5) / f.sy - 0.5 }
}

/** Physical pixels → image coordinates. */
export function toImage(f: Frame, x: number, y: number): Point {
  return { x: (x - f.x + 0.5) * f.sx - 0.5, y: (y - f.y + 0.5) * f.sy - 0.5 }
}

/** A rectangle given in image coordinates, as physical pixels. */
export function rectToPhysical(f: Frame, r: PixelRect): PixelRect {
  const x0 = f.x + r.x / f.sx
  const y0 = f.y + r.y / f.sy
  const x1 = f.x + (r.x + r.width) / f.sx
  const y1 = f.y + (r.y + r.height) / f.sy
  return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) }
}

/** A physical rectangle in image coordinates. */
export function rectToImage(f: Frame, r: PixelRect): PixelRect {
  return {
    x: Math.round((r.x - f.x) * f.sx),
    y: Math.round((r.y - f.y) * f.sy),
    width: Math.round(r.width * f.sx),
    height: Math.round(r.height * f.sy),
  }
}

/** One element of an accessibility listing (Android uiautomator or Windows UI Automation). */
export interface UiElement {
  index: number
  depth: number
  /** Short class / control type, e.g. Button, EditText. */
  role: string
  text?: string | undefined
  desc?: string | undefined
  id?: string | undefined
  value?: string | undefined
  /** Physical bounds. */
  bounds: PixelRect
  flags: string[]
  /** Backend handle used to act on the element again (UIA runtime id / path). */
  ref?: { runtimeId?: number[] | undefined; path?: string | undefined; hwnd?: number | undefined } | undefined
}

export function center(r: PixelRect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}

const q = (s: string) => JSON.stringify(s.length > 80 ? `${s.slice(0, 77)}...` : s)

/** One line per element, coordinates in the frame. */
export function formatElement(e: UiElement, f: Frame): string {
  const c = toImage(f, center(e.bounds).x, center(e.bounds).y)
  const w = Math.round(e.bounds.width * f.sx)
  const h = Math.round(e.bounds.height * f.sy)
  const label = [
    e.text ? q(e.text) : '',
    e.desc && e.desc !== e.text ? `desc=${q(e.desc)}` : '',
    e.id ? `#${e.id}` : '',
    e.value !== undefined && e.value !== '' && e.value !== e.text ? `value=${q(e.value)}` : '',
  ]
    .filter(Boolean)
    .join(' ')
  return `${'  '.repeat(Math.min(e.depth, 6))}[${e.index}] ${e.role}${label ? ` ${label}` : ''} @(${Math.round(c.x)},${Math.round(c.y)}) ${w}x${h}${e.flags.length ? ` [${e.flags.join(',')}]` : ''}`
}

export interface ShotOptions {
  /** Display index (Windows). */
  display?: number | undefined
  /** Window to capture. */
  window?: WindowInfo | undefined
  /** Zoom: a rectangle in the current frame's coordinates. */
  region?: PixelRect | undefined
  /** Long-edge limit of the returned image. */
  maxEdge?: number | undefined
  format?: ImageFormat | undefined
  quality?: number | undefined
  cursor?: boolean | undefined
  signal?: AbortSignal | undefined
}

export interface Shot extends EncodedImage {
  frame: Frame
  /** Pointer position in image coordinates, when requested and known. */
  cursor?: Point | undefined
  /** Physical rectangle shown. */
  rect: PixelRect
}

export const DEFAULT_MAX_EDGE = 1280
export const MIN_MAX_EDGE = 256
export const MAX_MAX_EDGE = 2048

export class ScreenSession {
  frame: Frame | undefined = undefined
  /** Display used by screenshots that do not name one. */
  display: number | undefined = undefined
  /** Window followed by screenshots that do not name a target (after a window screenshot). */
  window: WindowInfo | undefined = undefined
  maxEdge = DEFAULT_MAX_EDGE
  elements: UiElement[] = []
  /** Frame the elements were listed in (to detect stale indexes). */
  elementsAt = 0

  readonly env: Environment

  constructor(env: Environment) {
    this.env = env
  }

  /** Capture, crop/resize, encode, and make the result the current frame. */
  async shoot(o: ShotOptions = {}): Promise<Shot> {
    const maxEdge = Math.min(MAX_MAX_EDGE, Math.max(MIN_MAX_EDGE, Math.round(o.maxEdge ?? this.maxEdge)))
    if (o.maxEdge !== undefined && !o.region) this.maxEdge = maxEdge
    let want: PixelRect | undefined
    if (o.region) {
      const f = await this.ensureFrame(o.signal)
      if (o.region.width <= 0 || o.region.height <= 0) throw new EnvError('EINVAL', 'region needs a positive size')
      want = rectToPhysical(f, o.region)
    }
    const display = o.display ?? this.display
    const window = o.region ? undefined : o.window
    const cap = await this.env.capture({
      display,
      rect: want,
      window: window?.hwnd,
      maxWidth: want ? undefined : maxEdge,
      maxHeight: want ? undefined : maxEdge,
      cursor: o.cursor,
      signal: o.signal,
    })
    let covered = cap.rect
    let img: RgbImage | undefined = cap.image
    const pixels = () => {
      if (img) return img
      if (!cap.png || !isPng(cap.png)) throw new EnvError('EIO', 'the environment returned no image')
      img = decodePng(cap.png)
      return img
    }
    if (want) {
      // The environment may return more than asked (e.g. Android always captures the full screen).
      const x0 = Math.max(want.x, covered.x)
      const y0 = Math.max(want.y, covered.y)
      const x1 = Math.min(want.x + want.width, covered.x + covered.width)
      const y1 = Math.min(want.y + want.height, covered.y + covered.height)
      if (x1 <= x0 || y1 <= y0) throw new EnvError('EINVAL', 'region lies outside the screen')
      const inner = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
      if (
        inner.x !== covered.x ||
        inner.y !== covered.y ||
        inner.width !== covered.width ||
        inner.height !== covered.height
      ) {
        const kx = cap.width / covered.width
        const ky = cap.height / covered.height
        img = crop(pixels(), {
          x: (inner.x - covered.x) * kx,
          y: (inner.y - covered.y) * ky,
          width: inner.width * kx,
          height: inner.height * ky,
        })
      }
      covered = inner
    }
    // Zooms may enlarge small regions up to 2x so small text becomes legible.
    const target = fitSize(covered.width, covered.height, maxEdge, want ? 2 : 1)
    const curW = img?.width ?? cap.width
    const curH = img?.height ?? cap.height
    if (curW !== target.width || curH !== target.height) img = resize(pixels(), target.width, target.height)
    let encoded: EncodedImage
    if (!img && cap.png && (o.format ?? 'auto') !== 'jpeg') {
      // Pass the server's PNG through untouched unless auto mode finds it bloated.
      encoded =
        (o.format ?? 'auto') === 'auto' && cap.png.length > target.width * target.height * 0.6
          ? encodeImage(pixels(), 'auto', o.quality)
          : { data: cap.png, mediaType: 'image/png' }
    } else {
      encoded = encodeImage(pixels(), o.format ?? 'auto', o.quality ?? 80)
    }
    const frame: Frame = {
      x: covered.x,
      y: covered.y,
      sx: target.width / covered.width,
      sy: target.height / covered.height,
      width: target.width,
      height: target.height,
      kind: want ? 'region' : window ? 'window' : 'screen',
      display: want || window ? undefined : display,
      window,
    }
    this.frame = frame
    if (!want) {
      this.window = window
      if (o.display !== undefined) this.display = o.display
    }
    return {
      ...encoded,
      frame,
      rect: covered,
      cursor: cap.cursor ? toImage(frame, cap.cursor.x, cap.cursor.y) : undefined,
    }
  }

  /** The current frame, taking a (discarded) screenshot first when none exists. */
  async ensureFrame(signal?: AbortSignal): Promise<Frame> {
    if (this.frame) return this.frame
    return (await this.shoot({ signal })).frame
  }

  /** Frame coordinates → physical, after making sure a frame exists. */
  async physical(x: number, y: number, signal?: AbortSignal): Promise<Point> {
    return toPhysical(await this.ensureFrame(signal), x, y)
  }

  element(index: number): UiElement {
    const e = this.elements.find(el => el.index === index)
    if (!e) {
      throw new EnvError(
        'EINVAL',
        this.elements.length
          ? `no element [${index}] in the latest ui listing (0..${this.elements.length - 1})`
          : 'no ui listing yet; call the ui tool first',
      )
    }
    return e
  }
}

/** Describe a frame for the model. */
export function describeFrame(f: Frame, rect: PixelRect): string {
  const where =
    f.kind === 'window'
      ? `window ${JSON.stringify(f.window?.title ?? '')}`
      : f.kind === 'region'
        ? `zoomed region`
        : f.display !== undefined && f.display >= 0
          ? `display ${f.display}`
          : f.display === -1
            ? 'all displays'
            : 'screen'
  const scale = f.sx === 1 && f.sy === 1 ? '1:1' : `scale ${f.sx.toFixed(3)}`
  return `Image ${f.width}x${f.height} of ${where} (physical ${rect.width}x${rect.height} at ${rect.x},${rect.y}; ${scale}). From now on all x/y coordinates (input, ui, windows) are pixels of THIS image: (0,0) top-left .. (${f.width - 1},${f.height - 1}) bottom-right.`
}

/** Map an action's frame coordinates (and element reference) to physical pixels. */
export async function mapAction(
  s: ScreenSession,
  a: InputActionFields & { element?: number | undefined },
  signal?: AbortSignal,
): Promise<InputActionFields> {
  const { element, ...rest } = a
  const out: InputActionFields = { ...rest }
  if (element !== undefined) {
    const c = center(s.element(element).bounds)
    out.x = c.x
    out.y = c.y
  } else if (a.x !== undefined && a.y !== undefined) {
    const p = await s.physical(a.x, a.y, signal)
    out.x = p.x
    out.y = p.y
  }
  if (a.x2 !== undefined && a.y2 !== undefined) {
    const p = await s.physical(a.x2, a.y2, signal)
    out.x2 = p.x
    out.y2 = p.y
  }
  if (a.path) {
    const f = await s.ensureFrame(signal)
    out.path = a.path.map(([x, y]) => {
      const p = toPhysical(f, x, y)
      return [p.x, p.y] as const
    })
  }
  for (const k of ['x', 'y', 'x2', 'y2'] as const) {
    const v = out[k]
    if (v !== undefined) out[k] = Math.round(v)
  }
  if (out.path) out.path = out.path.map(([x, y]) => [Math.round(x), Math.round(y)] as const)
  return out
}
