// Window management of a Windows environment: list, focus, minimize, maximize, restore, close, move.
import { EnvError } from '@dsh-environments/protocol'
import { TEXT_OUTPUT } from '../common.ts'
import { rectToPhysical, type ScreenSession } from '../screen/session.ts'
import { formatWindow, resolveWindow } from '../screen/windows.ts'
import type { LeaseToolContext } from './context.ts'

export function addWindowTools({ env, alias: a, label: name, add }: LeaseToolContext, session: ScreenSession): void {
  if (!env.hasCap('windows')) return
  add({
    name: 'windows',
    description: `List the top-level windows of ${name} (z-order, topmost first, with handle, title, process and position in the latest screenshot's pixels) or focus / minimize / maximize / restore / close / move one. Select the window by title substring, process name (e.g. "notepad") or hwnd. close asks the window to close (like clicking X; it may show a save prompt). Use ${a}__screenshot window=... to capture a single window.`,
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'focus', 'minimize', 'maximize', 'restore', 'close', 'move'],
        description: 'Default list.',
      },
      window: { type: 'string', description: 'Title substring, process name or hwnd (default: foreground window).' },
      all: { type: 'boolean', description: 'list: include hidden, untitled and tool windows.' },
      x: { type: 'number', description: 'move: new left edge (screenshot coordinates).' },
      y: { type: 'number' },
      width: { type: 'number' },
      height: { type: 'number' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const signal = exec.signal
      const action = args.action ?? 'list'
      if (action === 'list') {
        const list = await env.windows({ signal, all: !!args.all })
        const frame = session.frame
        return (
          `${list.length} window${list.length === 1 ? '' : 's'}${frame ? ' (positions in the latest screenshot pixels)' : ' (physical pixels; take a screenshot to switch to its coordinates)'}:\n` +
          list.map(w => formatWindow(w, frame)).join('\n')
        )
      }
      const w = await resolveWindow(env, args.window, signal)
      let rect
      if (action === 'move') {
        const { x, y, width, height } = args
        if (x === undefined || y === undefined || width === undefined || height === undefined)
          throw new EnvError('EINVAL', 'move needs x, y, width and height')
        rect = rectToPhysical(await session.ensureFrame(signal), { x, y, width, height })
      }
      const r = await env.windowAction(w.hwnd, action, rect, { signal })
      if (session.window?.hwnd === w.hwnd && action === 'close') session.window = undefined
      const state = action === 'focus' && !r.foreground ? ' — Windows refused to bring it to the front' : ''
      return `${action} ${JSON.stringify(w.title)} (hwnd=${w.hwnd}): ${r.ok ? 'done' : 'failed'}${state}${r.foreground ? '; it is now the foreground window' : ''}.`
    },
  })
}
