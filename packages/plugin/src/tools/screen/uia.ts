// Windows UI Automation through Windows PowerShell's System.Windows.Automation, run inside the
// environment. No COM code ships in dsh-env-server: powershell.exe is present on every Windows
// desktop and the managed client caches a whole subtree in one cross-process call.
import { EnvError, type PixelRect } from '@dsh-environments/protocol'
import type { Environment } from '../../env/environment.ts'
import type { WindowInfo } from '../../env/types.ts'
import type { UiFilter } from './android-ui.ts'
import type { UiElement } from './session.ts'

export const UIA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Out-Json($o) {
  $s = ConvertTo-Json -InputObject $o -Depth 8 -Compress
  $s = [regex]::Replace($s, '[^\x00-\x7e]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  [Console]::Out.Write($s)
}
function Rect($r) {
  if ($r.IsEmpty -or [double]::IsInfinity($r.Width) -or $r.Width -le 0) { return $null }
  return @([int][math]::Round($r.X), [int][math]::Round($r.Y), [int][math]::Round($r.Width), [int][math]::Round($r.Height))
}
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  try { Add-Type -AssemblyName UIAutomationClientsideProviders } catch {}
  $req = '__REQ__' | ConvertFrom-Json
  $A = [System.Windows.Automation.AutomationElement]
  $NS = $A::NotSupported
  $root = $A::FromHandle([IntPtr][long]$req.hwnd)
  if ($req.op -eq 'list') {
    $cr = New-Object System.Windows.Automation.CacheRequest
    $cr.TreeScope = [System.Windows.Automation.TreeScope]::Subtree
    if (-not $req.raw) { $cr.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition }
    $cr.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::None
    $props = @($A::NameProperty, $A::ControlTypeProperty, $A::AutomationIdProperty, $A::ClassNameProperty,
      $A::BoundingRectangleProperty, $A::IsEnabledProperty, $A::IsOffscreenProperty, $A::HasKeyboardFocusProperty,
      $A::IsKeyboardFocusableProperty, $A::RuntimeIdProperty, $A::IsInvokePatternAvailableProperty,
      $A::IsTogglePatternAvailableProperty, $A::IsValuePatternAvailableProperty,
      $A::IsExpandCollapsePatternAvailableProperty, $A::IsSelectionItemPatternAvailableProperty,
      $A::IsScrollPatternAvailableProperty, $A::IsRangeValuePatternAvailableProperty,
      [System.Windows.Automation.ValuePattern]::ValueProperty,
      [System.Windows.Automation.TogglePattern]::ToggleStateProperty,
      [System.Windows.Automation.ExpandCollapsePattern]::ExpandCollapseStateProperty,
      [System.Windows.Automation.SelectionItemPattern]::IsSelectedProperty)
    foreach ($p in $props) { $cr.Add($p) }
    $c = $root.GetUpdatedCache($cr)
    $out = New-Object System.Collections.ArrayList
    $limit = [int]$req.limit
    $maxDepth = [int]$req.depth
    function Walk($e, [int]$d, [string]$path) {
      if ($out.Count -ge $limit) { return }
      $pats = @()
      if ($e.GetCachedPropertyValue($A::IsInvokePatternAvailableProperty)) { $pats += 'invoke' }
      if ($e.GetCachedPropertyValue($A::IsTogglePatternAvailableProperty)) {
        $ts = $e.GetCachedPropertyValue([System.Windows.Automation.TogglePattern]::ToggleStateProperty)
        $pats += $(if ("$ts" -eq 'On') { 'on' } elseif ("$ts" -eq 'Off') { 'off' } else { 'toggle' })
      }
      if ($e.GetCachedPropertyValue($A::IsExpandCollapsePatternAvailableProperty)) {
        $es = $e.GetCachedPropertyValue([System.Windows.Automation.ExpandCollapsePattern]::ExpandCollapseStateProperty)
        if ("$es" -ne 'LeafNode') { $pats += $(if ("$es" -eq 'Expanded') { 'expanded' } else { 'collapsed' }) }
      }
      if ($e.GetCachedPropertyValue($A::IsSelectionItemPatternAvailableProperty)) {
        $pats += $(if ($e.GetCachedPropertyValue([System.Windows.Automation.SelectionItemPattern]::IsSelectedProperty) -eq $true) { 'selected' } else { 'selectable' })
      }
      if ($e.GetCachedPropertyValue($A::IsScrollPatternAvailableProperty)) { $pats += 'scrollable' }
      if ($e.GetCachedPropertyValue($A::IsRangeValuePatternAvailableProperty)) { $pats += 'range' }
      $v = $null
      if ($e.GetCachedPropertyValue($A::IsValuePatternAvailableProperty)) {
        $pats += 'value'
        $vv = $e.GetCachedPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty)
        if ($vv -ne $NS -and $null -ne $vv) { $v = [string]$vv; if ($v.Length -gt 200) { $v = $v.Substring(0, 200) + '...' } }
      }
      $ct = $e.GetCachedPropertyValue($A::ControlTypeProperty)
      $n = [string]$e.GetCachedPropertyValue($A::NameProperty)
      if ($n.Length -gt 200) { $n = $n.Substring(0, 200) + '...' }
      [void]$out.Add([ordered]@{
        d = $d; p = $path
        t = ("$($ct.ProgrammaticName)" -replace '^ControlType\.', '')
        n = $n
        id = [string]$e.GetCachedPropertyValue($A::AutomationIdProperty)
        c = [string]$e.GetCachedPropertyValue($A::ClassNameProperty)
        r = (Rect $e.GetCachedPropertyValue($A::BoundingRectangleProperty))
        en = [bool]$e.GetCachedPropertyValue($A::IsEnabledProperty)
        off = [bool]$e.GetCachedPropertyValue($A::IsOffscreenProperty)
        foc = [bool]$e.GetCachedPropertyValue($A::HasKeyboardFocusProperty)
        kf = [bool]$e.GetCachedPropertyValue($A::IsKeyboardFocusableProperty)
        pat = $pats
        v = $v
        rid = @($e.GetCachedPropertyValue($A::RuntimeIdProperty))
      })
      if ($d -lt $maxDepth) {
        $i = 0
        foreach ($ch in $e.CachedChildren) { Walk $ch ($d + 1) "$path/$i"; $i++ }
      }
    }
    Walk $c 0 ''
    Out-Json ([ordered]@{ root = (Rect $c.GetCachedPropertyValue($A::BoundingRectangleProperty)); items = $out; truncated = ($out.Count -ge $limit) })
  } else {
    $el = $null
    if ($req.rid) {
      $cond = New-Object System.Windows.Automation.PropertyCondition($A::RuntimeIdProperty, [int[]]$req.rid)
      $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $cond)
    }
    if (-not $el -and $null -ne $req.path) {
      $w = [System.Windows.Automation.TreeWalker]::ControlViewWalker
      $el = $root
      foreach ($s in ($req.path -split '/' | Where-Object { $_ -ne '' })) {
        $ch = $w.GetFirstChild($el)
        for ($k = 0; $k -lt [int]$s -and $ch; $k++) { $ch = $w.GetNextSibling($ch) }
        $el = $ch
        if (-not $el) { break }
      }
    }
    if (-not $el) { throw 'element not found (the UI changed); list the elements again' }
    function Pat($pat) { $o = $null; if ($el.TryGetCurrentPattern($pat, [ref]$o)) { return $o } return $null }
    $used = $req.action
    switch ($req.action) {
      'click' {
        $p = Pat ([System.Windows.Automation.InvokePattern]::Pattern)
        if ($p) { $p.Invoke(); $used = 'invoke'; break }
        $p = Pat ([System.Windows.Automation.TogglePattern]::Pattern)
        if ($p) { $p.Toggle(); $used = 'toggle'; break }
        $p = Pat ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($p) { $p.Select(); $used = 'select'; break }
        $p = Pat ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($p) {
          if ("$($p.Current.ExpandCollapseState)" -eq 'Expanded') { $p.Collapse(); $used = 'collapse' } else { $p.Expand(); $used = 'expand' }
          break
        }
        $used = 'mouse'
      }
      'invoke' { $p = Pat ([System.Windows.Automation.InvokePattern]::Pattern); if (-not $p) { throw 'the element does not support Invoke' }; $p.Invoke() }
      'toggle' { $p = Pat ([System.Windows.Automation.TogglePattern]::Pattern); if (-not $p) { throw 'the element does not support Toggle' }; $p.Toggle() }
      'select' { $p = Pat ([System.Windows.Automation.SelectionItemPattern]::Pattern); if (-not $p) { throw 'the element does not support selection' }; $p.Select() }
      'expand' { $p = Pat ([System.Windows.Automation.ExpandCollapsePattern]::Pattern); if (-not $p) { throw 'the element cannot expand' }; $p.Expand() }
      'collapse' { $p = Pat ([System.Windows.Automation.ExpandCollapsePattern]::Pattern); if (-not $p) { throw 'the element cannot collapse' }; $p.Collapse() }
      'scroll_into_view' { $p = Pat ([System.Windows.Automation.ScrollItemPattern]::Pattern); if (-not $p) { throw 'the element does not support ScrollIntoView' }; $p.ScrollIntoView() }
      'focus' { $el.SetFocus() }
      'set_text' {
        $p = Pat ([System.Windows.Automation.ValuePattern]::Pattern)
        if ($p -and -not $p.Current.IsReadOnly) { $p.SetValue([string]$req.value); $used = 'value' }
        else { try { $el.SetFocus() } catch {}; $used = 'focus' }
      }
      default { throw "unknown action $($req.action)" }
    }
    $r = $null
    try { $r = Rect $el.Current.BoundingRectangle } catch {}
    Out-Json ([ordered]@{ used = $used; rect = $r })
  }
} catch {
  Out-Json @{ error = $_.Exception.Message }
}
`

/** The `-EncodedCommand` argument for a request. */
export function uiaCommand(req: Record<string, unknown>): string {
  const json = JSON.stringify(req).replace(
    /[\u007f-\uffff]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
  const script = UIA_SCRIPT.replace("'__REQ__'", `'${json.replace(/'/g, "''")}'`)
  return Buffer.from(script, 'utf16le').toString('base64')
}

interface UiaItem {
  d: number
  p: string
  t: string
  n: string
  id: string
  c: string
  r: [number, number, number, number] | null
  en: boolean
  off: boolean
  foc: boolean
  kf: boolean
  pat: string[] | string | null
  v: string | null
  rid: number[] | number | null
}

interface UiaList {
  root: [number, number, number, number] | null
  items: UiaItem[] | UiaItem | null
  truncated: boolean
  error?: string
}

interface UiaAct {
  used: string
  rect: [number, number, number, number] | null
  error?: string
}

const arr = <T>(v: T[] | T | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v])

async function runUia<T extends { error?: string }>(
  env: Environment,
  req: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const r = await env.exec(
    {
      argv: [
        'powershell.exe',
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        uiaCommand(req),
      ],
    },
    { signal, timeoutMs: 60000, maxBytes: 32 * 1024 * 1024 },
  )
  const text = r.stdout.toString('utf8').trim()
  const start = text.indexOf('{')
  if (start < 0) {
    throw new EnvError(
      'EIO',
      `UI Automation failed: ${(r.stderr.toString('utf8') || text || `exit ${r.code}`).slice(0, 500)}`,
    )
  }
  const value = JSON.parse(text.slice(start)) as T
  if (value.error) throw new EnvError('EIO', `UI Automation: ${value.error}`)
  return value
}

/** Map UIA coordinates to physical pixels using the window's physical rectangle. */
export function uiaMapper(
  root: [number, number, number, number] | null,
  win: PixelRect,
): (r: [number, number, number, number]) => PixelRect {
  if (!root || root[2] <= 0 || root[3] <= 0) return ([x, y, w, h]) => ({ x, y, width: w, height: h })
  const sx = win.width / root[2]
  const sy = win.height / root[3]
  // Same DPI view (the usual case: UIA reports physical pixels). The root rectangle includes
  // invisible resize borders the window frame omits, so small differences are expected.
  if (Math.abs(sx - 1) < 0.1 && Math.abs(sy - 1) < 0.1) return ([x, y, w, h]) => ({ x, y, width: w, height: h })
  // DPI-virtualized coordinates: scale around the window.
  return ([x, y, w, h]) => ({
    x: Math.round(win.x + (x - root[0]) * sx),
    y: Math.round(win.y + (y - root[1]) * sy),
    width: Math.round(w * sx),
    height: Math.round(h * sy),
  })
}

const INTERACTIVE_TYPES = new Set([
  'Button',
  'CheckBox',
  'ComboBox',
  'Edit',
  'Hyperlink',
  'ListItem',
  'MenuItem',
  'RadioButton',
  'Slider',
  'SplitButton',
  'Spinner',
  'TabItem',
  'TreeItem',
  'DataItem',
  'Document',
  'ScrollBar',
  'Thumb',
])

export interface UiaListOptions {
  filter?: UiFilter | undefined
  query?: string | undefined
  depth?: number | undefined
  limit?: number | undefined
  signal?: AbortSignal | undefined
}

/** List the UI elements of a window. */
export async function listUia(
  env: Environment,
  win: WindowInfo,
  opts: UiaListOptions = {},
): Promise<{ elements: UiElement[]; truncated: boolean }> {
  const filter = opts.filter ?? 'default'
  const res = await runUia<UiaList>(
    env,
    { op: 'list', hwnd: win.hwnd, depth: opts.depth ?? 40, limit: 3000, raw: false },
    opts.signal,
  )
  const map = uiaMapper(res.root, win)
  const query = opts.query?.toLowerCase()
  const out: UiElement[] = []
  const limit = opts.limit ?? 300
  const names = new Map<string, string>()
  for (const it of arr(res.items)) {
    if (!it.r) continue
    const pats = arr(it.pat)
    const interactive = pats.length > 0 || (it.kf && INTERACTIVE_TYPES.has(it.t))
    if (interactive && it.n) names.set(it.p, it.n.trim())
    if (filter !== 'all' && it.off) continue
    if (filter === 'interactive' && !interactive) continue
    if (filter === 'default' && !interactive && !it.n.trim()) continue
    // A label that only repeats its control's name (Button > Text "OK") adds nothing.
    if (filter !== 'all' && !interactive && names.get(it.p.slice(0, it.p.lastIndexOf('/'))) === it.n.trim()) continue
    if (query && !`${it.n}\n${it.id}\n${it.v ?? ''}\n${it.t}`.toLowerCase().includes(query)) continue
    if (out.length >= limit) break
    const flags = [...pats]
    if (it.foc) flags.push('focused')
    if (!it.en) flags.push('disabled')
    if (it.off) flags.push('offscreen')
    out.push({
      index: out.length,
      depth: filter === 'all' ? it.d : 0,
      role: it.t || 'Custom',
      text: it.n.trim() || undefined,
      id: it.id || undefined,
      value: it.v ?? undefined,
      bounds: map(it.r),
      flags,
      ref: { runtimeId: arr(it.rid), path: it.p, hwnd: win.hwnd },
    })
  }
  return { elements: out, truncated: res.truncated }
}

export type UiaAction =
  'click' | 'invoke' | 'toggle' | 'select' | 'expand' | 'collapse' | 'scroll_into_view' | 'focus' | 'set_text'

/** Act on an element through its UIA patterns. `used` is 'mouse' when the caller must click instead. */
export async function actUia(
  env: Environment,
  el: UiElement,
  action: UiaAction,
  value?: string,
  signal?: AbortSignal,
): Promise<{ used: string }> {
  if (!el.ref?.hwnd) throw new EnvError('EINVAL', 'this element has no UI Automation reference')
  const res = await runUia<UiaAct>(
    env,
    {
      op: 'act',
      hwnd: el.ref.hwnd,
      rid: el.ref.runtimeId ?? null,
      path: el.ref.path ?? null,
      action,
      value: value ?? '',
    },
    signal,
  )
  return { used: res.used }
}
