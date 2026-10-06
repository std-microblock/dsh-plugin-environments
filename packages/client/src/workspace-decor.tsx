// Sidebar decorations of DSH workspace rows: a link icon on remote workspaces, the bound
// environment (with a red dot when it is unavailable) and an "Environment…" row in the
// workspace "..." menu.
//
// DSH declares no seat inside a workspace header row or its menu (only Session rows have
// seats), so this is a scoped DOM decoration: the component is an ordinary `shell.overlay`
// entry that finds rows by their stable `role="treeitem"` + `data-row-key="workspace:<id>"`
// attributes, inserts two marked host elements into each bound row and renders into them
// with React portals. Everything it inserts carries `data-envx-ws` and is removed on unmount.
import * as React from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { isUnavailable, workspaceIdOfRowKey, type WorkspaceRef } from './binding-logic.ts'
import type { BindingsStore } from './bindings.ts'
import type { Translate } from './host-api.ts'
import { IconLink, KindIcon } from './icons.tsx'
import type { AvailabilityView, BindingView, BindingsView } from './types.ts'
import { WorkspaceEnvDialog } from './workspace-dialog.tsx'

/** The part of DSH's workspace snapshot read here (`useWorkspaces` standard hook). */
export interface WorkspaceSnapshotLike {
  items: readonly { workspaceId: string; path: string; title: string }[]
}
export type UseWorkspaces = <S>(selector: (snapshot: WorkspaceSnapshotLike) => S) => S

const ROW_SELECTOR = '[role="treeitem"][data-row-key^="workspace:"]'
const HOST_ATTR = 'data-envx-ws'
const MENU_ITEM_ATTR = 'data-envx-ws-menu'
const EMPTY: readonly { workspaceId: string; path: string; title: string }[] = []
const useNoWorkspaces: UseWorkspaces = selector => selector({ items: EMPTY })
const selectItems = (s: WorkspaceSnapshotLike) => s.items

/** Static markup of the menu row icon (the environments glyph). */
const MENU_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="12" height="9" rx="1.6"/><path d="M7 17h4M9 13v4"/><rect x="16" y="9" width="5" height="11" rx="1.4"/><path d="M18 17.5h1"/></svg>'

interface Decoration {
  workspaceId: string
  row: HTMLElement
  lead: HTMLElement
  trail: HTMLElement
}

function makeHost(kind: 'lead' | 'trail'): HTMLElement {
  const el = document.createElement('span')
  el.setAttribute(HOST_ATTR, kind)
  el.style.display = 'contents'
  return el
}

/** Place the lead host right after the icon cells (before the first child carrying text: the title). */
function placeLead(row: HTMLElement, lead: HTMLElement): void {
  const title = Array.from(row.children).find(c => !c.hasAttribute(HOST_ATTR) && (c.textContent ?? '').trim() !== '')
  if (lead.parentElement !== row || lead.nextElementSibling !== title) row.insertBefore(lead, title ?? null)
}

/** Place the trail host before the hover actions (the first child holding buttons), else at the end. */
function placeTrail(row: HTMLElement, trail: HTMLElement): void {
  const actions = Array.from(row.children).find(c => !c.hasAttribute(HOST_ATTR) && c.querySelector('button'))
  if (trail.parentElement !== row || trail.nextElementSibling !== (actions ?? null))
    row.insertBefore(trail, actions ?? null)
}

function sameDecorations(a: readonly Decoration[], b: readonly Decoration[]): boolean {
  return (
    a.length === b.length &&
    a.every((d, i) => {
      const e = b[i]
      return !!e && d.workspaceId === e.workspaceId && d.row === e.row && d.lead === e.lead && d.trail === e.trail
    })
  )
}

function stateLabel(t: Translate, a: AvailabilityView | undefined): string {
  if (!a) return ''
  const label = t(`ws.state.${a.state}`)
  return a.reason ? `${label} · ${a.reason}` : label
}

function Lead({ binding, envName, t }: { binding: BindingView; envName: string; t: Translate }) {
  return (
    <span
      className="envx-ws-lead"
      title={t('ws.remote.title', { env: envName, root: binding.remoteRoot ?? '' })}
      aria-label={t('ws.remote.aria', { env: envName })}
      role="img"
    >
      <IconLink size={13} />
    </span>
  )
}

function Tag({
  binding,
  view,
  t,
  onOpen,
}: {
  binding: BindingView
  view: BindingsView | undefined
  t: Translate
  onOpen: (() => void) | undefined
}) {
  const env = view?.environments.find(e => e.id === binding.envId)
  const a = binding.envId ? view?.availability[binding.envId] : undefined
  const name = env?.name ?? binding.envId ?? ''
  const unavailable = isUnavailable(a?.state)
  const title = [
    binding.kind === 'remote' ? t('ws.tag.remote', { name }) : t('ws.tag.default', { name }),
    stateLabel(t, a),
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <button
      type="button"
      className="envx-ws-tag"
      data-kind={binding.kind}
      data-state={a?.state ?? 'unknown'}
      title={title}
      aria-label={title}
      tabIndex={onOpen ? 0 : -1}
      onClick={e => {
        e.stopPropagation()
        e.preventDefault()
        onOpen?.()
      }}
      onPointerDown={e => e.stopPropagation()}
      onDragStart={e => e.preventDefault()}
    >
      <KindIcon kind={env?.kind} size={12} />
      <span className="envx-ws-tag-name">{name}</span>
      {(unavailable || a?.state === 'busy') && (
        <span className="envx-ws-dot" data-state={a?.state} aria-hidden="true" />
      )}
    </button>
  )
}

export interface WorkspaceDecorationsProps {
  store: BindingsStore
  t: Translate
  /** DSH's global `useWorkspaces` standard hook (absent on hosts without the workspace UI). */
  useWorkspaces?: UseWorkspaces | undefined
}

export function WorkspaceDecorations({ store, t, useWorkspaces }: WorkspaceDecorationsProps) {
  const useItems = useWorkspaces ?? useNoWorkspaces
  const items = useItems(selectItems)
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [decorations, setDecorations] = useState<readonly Decoration[]>([])
  const [rowIds, setRowIds] = useState<readonly string[]>([])
  const [dialog, setDialog] = useState<{ workspaceId: string; path?: string | undefined; title?: string | undefined }>()
  const hosts = useRef(new Map<HTMLElement, { lead: HTMLElement; trail: HTMLElement }>())
  const byIdRef = useRef(snapshot.byId)
  byIdRef.current = snapshot.byId
  const supportedRef = useRef(snapshot.supported)
  supportedRef.current = snapshot.supported
  const itemsRef = useRef(items)
  itemsRef.current = items

  // Tell the store which workspaces are listed: the workspace snapshot when available,
  // otherwise the ids found in the sidebar (the host resolves their paths).
  useEffect(() => {
    const refs: WorkspaceRef[] =
      items.length > 0
        ? items.map(w => ({ workspaceId: w.workspaceId, path: w.path }))
        : rowIds.map(workspaceId => ({ workspaceId }))
    store.setWorkspaces(refs)
  }, [items, rowIds, store])

  const openDialog = useCallback((workspaceId: string) => {
    const item = itemsRef.current.find(w => w.workspaceId === workspaceId)
    const binding = byIdRef.current.get(workspaceId)
    setDialog({ workspaceId, path: item?.path ?? binding?.path, title: item?.title })
  }, [])

  // Find workspace rows and keep one pair of hosts in every bound row.
  const sync = useCallback(() => {
    const byId = byIdRef.current
    const seen = new Set<HTMLElement>()
    const ids: string[] = []
    const next: Decoration[] = []
    for (const row of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      const workspaceId = workspaceIdOfRowKey(row.getAttribute('data-row-key'))
      if (!workspaceId) continue
      ids.push(workspaceId)
      const binding = byId.get(workspaceId)
      if (!binding?.envId || binding.kind === 'host') continue
      seen.add(row)
      let pair = hosts.current.get(row)
      if (!pair) {
        pair = { lead: makeHost('lead'), trail: makeHost('trail') }
        hosts.current.set(row, pair)
      }
      placeLead(row, pair.lead)
      placeTrail(row, pair.trail)
      next.push({ workspaceId, row, lead: pair.lead, trail: pair.trail })
    }
    for (const [row, pair] of hosts.current) {
      if (seen.has(row)) continue
      pair.lead.remove()
      pair.trail.remove()
      hosts.current.delete(row)
    }
    setDecorations(prev => (sameDecorations(prev, next) ? prev : next))
    setRowIds(prev => (prev.length === ids.length && prev.every((v, i) => v === ids[i]) ? prev : ids))
  }, [])

  useLayoutEffect(() => {
    sync()
  }, [snapshot.byId, sync])

  // Re-sync when the sidebar tree changes; inject the menu row when a workspace menu opens.
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
    let frame = 0
    let lastTrigger: { workspaceId: string; at: number } | undefined
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        sync()
      })
    }
    const injectMenuItem = (menu: Element, workspaceId: string) => {
      if (menu.querySelector(`[${MENU_ITEM_ATTR}]`)) return
      const template = menu.querySelector<HTMLButtonElement>('button[role="menuitem"]')
      const wrapTemplate = template?.parentElement
      if (!template || !wrapTemplate) return
      const wrap = document.createElement('div')
      wrap.className = wrapTemplate.className
      wrap.setAttribute(MENU_ITEM_ATTR, workspaceId)
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.className = template.className
      const [iconTemplate, labelTemplate] = Array.from(template.children)
      const icon = document.createElement('span')
      icon.className = iconTemplate?.className ?? ''
      icon.innerHTML = MENU_ICON
      const label = document.createElement('span')
      label.className = labelTemplate?.className ?? ''
      label.textContent = t('ws.menu')
      button.append(icon, label)
      button.addEventListener('click', event => {
        event.preventDefault()
        // Close the host menu the way an outside press does, then open our dialog.
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        openDialog(workspaceId)
      })
      wrap.append(button)
      const wraps = Array.from(wrapTemplate.parentElement?.children ?? []).filter(
        c => c.querySelector('button[role="menuitem"]') !== null,
      )
      const last = wraps[wraps.length - 1]
      // Before the destructive last row (delete), else at the end.
      if (last && last !== wrapTemplate) last.before(wrap)
      else wrapTemplate.after(wrap)
    }
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const row = target?.closest(ROW_SELECTOR)
      if (!row || !target?.closest('button')) return
      const workspaceId = workspaceIdOfRowKey(row.getAttribute('data-row-key'))
      if (workspaceId) lastTrigger = { workspaceId, at: Date.now() }
    }
    const observer = new MutationObserver(records => {
      let rows = false
      for (const r of records) {
        const target = r.target instanceof Element ? r.target : null
        if (target === document.body) {
          for (const node of r.addedNodes) {
            if (!(node instanceof Element)) continue
            const menu = node.matches('[role="menu"]') ? node : node.querySelector('[role="menu"]')
            if (menu && lastTrigger && Date.now() - lastTrigger.at < 1500 && supportedRef.current === true) {
              injectMenuItem(menu, lastTrigger.workspaceId)
              lastTrigger = undefined
            }
          }
          rows = true
        } else if (target?.closest('[role="tree"]')) rows = true
      }
      if (rows) schedule()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('click', onClick, true)
    const pairs = hosts.current
    return () => {
      observer.disconnect()
      document.removeEventListener('click', onClick, true)
      cancelAnimationFrame(frame)
      for (const pair of pairs.values()) {
        pair.lead.remove()
        pair.trail.remove()
      }
      pairs.clear()
      for (const el of document.querySelectorAll(`[${MENU_ITEM_ATTR}]`)) el.remove()
    }
  }, [sync, openDialog, t])

  const editable = snapshot.supported === true
  return (
    <>
      {decorations.map(d => {
        const binding = snapshot.byId.get(d.workspaceId)
        if (!binding) return null
        const envName = snapshot.view?.environments.find(e => e.id === binding.envId)?.name ?? binding.envId ?? ''
        return (
          <React.Fragment key={d.workspaceId}>
            {binding.kind === 'remote' && createPortal(<Lead binding={binding} envName={envName} t={t} />, d.lead)}
            {createPortal(
              <Tag
                binding={binding}
                view={snapshot.view}
                t={t}
                onOpen={editable ? () => openDialog(d.workspaceId) : undefined}
              />,
              d.trail,
            )}
          </React.Fragment>
        )
      })}
      {dialog && (
        <WorkspaceEnvDialog
          workspaceId={dialog.workspaceId}
          path={dialog.path}
          title={dialog.title}
          binding={snapshot.byId.get(dialog.workspaceId)}
          availability={snapshot.view?.availability ?? {}}
          t={t}
          onClose={() => setDialog(undefined)}
        />
      )}
    </>
  )
}
