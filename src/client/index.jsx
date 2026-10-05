import * as React from 'react'
import { useSyncExternalStore } from 'react'
import { NS, dictionaries } from './locales.js'
import CSS from './styles.css'
import { EnvironmentsPage } from './page.jsx'
import { EnvironmentChip } from './chip.jsx'
import { IconEnvironments } from './icons.jsx'

const PANEL_ID = 'environments'

export const inject = ['slots', 'locale', 'layout', 'uiWorkspace']

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'environments: dictionaries')
  const t = ctx.locale.bind(NS)
  const subscribeLocale = listener => ctx.locale.subscribe(listener)
  const localeSnapshot = () => ctx.locale.getSnapshot()

  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-plugin-environments'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'environments: styles')

  const openManager = () => {
    try { ctx.layout.selectPanel(PANEL_ID) } catch {}
  }
  const startSession = workspaceId => {
    try { ctx.uiWorkspace.startSession(workspaceId) } catch {}
  }

  function Page() {
    useSyncExternalStore(subscribeLocale, localeSnapshot)
    return <EnvironmentsPage t={t} startSession={startSession} />
  }

  function Chip({ sessionId }) {
    useSyncExternalStore(subscribeLocale, localeSnapshot)
    if (!sessionId) return null
    return <EnvironmentChip sessionId={sessionId} t={t} openManager={openManager} />
  }

  function PanelIcon({ size }) {
    return <IconEnvironments size={size} />
  }

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, Page))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    locale: NS,
    label: () => t('panel'),
  }, PanelIcon))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'environments',
    order: 60,
    locale: NS,
    inject: sessionId => ({ sessionId: sessionId === undefined ? undefined : String(sessionId) }),
  }, Chip))
}
