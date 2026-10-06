// Client module entry: registers the Environments page, its sidebar icon, the composer chip and the
// workspace-binding decorations of the sidebar (a `shell.overlay` entry, see workspace-decor.tsx).
import * as React from 'react'
import { useSyncExternalStore } from 'react'
import { BindingsStore } from './bindings.ts'
import { EnvironmentChip } from './chip.tsx'
import type { ClientContext } from './host-api.ts'
import { IconEnvironments } from './icons.tsx'
import { NS, dictionaries } from './locales.ts'
import { EnvironmentsPage } from './page.tsx'
import CSS from './styles.css'
import { WorkspaceDecorations, type UseWorkspaces } from './workspace-decor.tsx'

const PANEL_ID = 'environments'

export const inject = ['slots', 'locale', 'layout', 'uiWorkspace']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'environments: dictionaries')
  const t = ctx.locale.bind(NS)
  const subscribeLocale = (listener: () => void) => ctx.locale.subscribe(listener)
  const localeSnapshot = () => ctx.locale.getSnapshot()

  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const style = document.createElement('style')
    style.dataset['plugin'] = 'dsh-plugin-environments'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'environments: styles')

  const openManager = () => {
    try {
      ctx.layout.selectPanel(PANEL_ID)
    } catch {
      // layout not available
    }
  }
  const startSession = (workspaceId: string) => {
    try {
      ctx.uiWorkspace.startSession(workspaceId)
    } catch {
      // workspace UI not available
    }
  }

  function Page() {
    useSyncExternalStore(subscribeLocale, localeSnapshot)
    return <EnvironmentsPage t={t} startSession={startSession} />
  }

  function Chip({ sessionId }: { sessionId?: string | undefined }) {
    useSyncExternalStore(subscribeLocale, localeSnapshot)
    if (!sessionId) return null
    return <EnvironmentChip sessionId={sessionId} t={t} openManager={openManager} />
  }

  const bindings = new BindingsStore()
  function Decorations({ useWorkspaces }: { useWorkspaces?: UseWorkspaces | undefined }) {
    useSyncExternalStore(subscribeLocale, localeSnapshot)
    return <WorkspaceDecorations store={bindings} t={t} useWorkspaces={useWorkspaces} />
  }

  function PanelIcon({ size }: { size?: number }) {
    return <IconEnvironments size={size} />
  }

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      },
      Page,
    ),
  )

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        locale: NS,
        label: () => t('panel'),
      },
      PanelIcon,
    ),
  )

  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'environments',
        order: 60,
        locale: NS,
        inject: sessionId => ({ sessionId: sessionId === undefined ? undefined : String(sessionId) }),
      },
      Chip,
    ),
  )

  // Workspace rows have no DSH seat; the frame-wide overlay list hosts the decoration driver.
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'environments.workspace-bindings',
        locale: NS,
      },
      Decorations,
    ),
  )
}
