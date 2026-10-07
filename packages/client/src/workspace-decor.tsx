// Sidebar decorations of DSH workspace rows: remote workspaces show their bound environment
// (with a red dot when it is unavailable, an orange one when it is in use).
//
// DSH declares no seat inside a workspace header row (only Session rows have seats), so this
// is a scoped DOM decoration: the component is an ordinary `shell.overlay` entry that finds
// rows by their stable `role="treeitem"` + `data-row-key="workspace:<id>"` attributes, inserts
// one marked host element into each bound row and renders into it with a React portal.
// Everything it inserts carries `data-envx-ws` and is removed on unmount.
import * as React from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { isUnavailable, workspaceIdOfRowKey, type WorkspaceRef } from './binding-logic.ts'
import type { BindingsStore } from './bindings.ts'
import type { Translate } from './host-api.ts'
import { KindIcon } from './icons.tsx'
import type { AvailabilityView, BindingView, BindingsView } from './types.ts'

/** The part of DSH's workspace snapshot read here (`useWorkspaces` standard hook). */
export interface WorkspaceSnapshotLike {
  items: readonly { workspaceId: string; path: string; title: string }[]
}
export type UseWorkspaces = <S>(selector: (snapshot: WorkspaceSnapshotLike) => S) => S

const ROW_SELECTOR = '[role="treeitem"][data-row-key^="workspace:"]'
const HOST_ATTR = 'data-envx-ws'
const EMPTY: readonly { workspaceId: string; path: string; title: string }[] = []
const useNoWorkspaces: UseWorkspaces = selector => selector({ items: EMPTY })
const selectItems = (s: WorkspaceSnapshotLike) => s.items

interface Decoration {
  workspaceId: string
  row: HTMLElement
  trail: HTMLElement
}

function makeHost(): HTMLElement {
  const el = document.createElement('span')
  el.setAttribute(HOST_ATTR, 'trail')
  el.style.display = 'contents'
  return el
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
      return !!e && d.workspaceId === e.workspaceId && d.row === e.row && d.trail === e.trail
    })
  )
}

function stateLabel(t: Translate, a: AvailabilityView | undefined): string {
  if (!a) return ''
  const label = t(`ws.state.${a.state}`)
  return a.reason ? `${label} · ${a.reason}` : label
}

function Tag({ binding, view, t }: { binding: BindingView; view: BindingsView | undefined; t: Translate }) {
  const env = view?.environments.find(e => e.id === binding.envId)
  const a = binding.envId ? view?.availability[binding.envId] : undefined
  const name = env?.name ?? binding.envId ?? ''
  const unavailable = isUnavailable(a?.state)
  const title = [t('ws.tag.remote', { name, root: binding.remoteRoot ?? '' }), stateLabel(t, a)]
    .filter(Boolean)
    .join('\n')
  return (
    <span className="envx-ws-tag" data-state={a?.state ?? 'unknown'} title={title} aria-label={title} role="img">
      <KindIcon kind={env?.kind} size={12} />
      <span className="envx-ws-tag-name">{name}</span>
      {(unavailable || a?.state === 'busy') && (
        <span className="envx-ws-dot" data-state={a?.state} aria-hidden="true" />
      )}
    </span>
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
  const hosts = useRef(new Map<HTMLElement, HTMLElement>())
  const byIdRef = useRef(snapshot.byId)
  byIdRef.current = snapshot.byId

  // Tell the store which workspaces are listed: the workspace snapshot when available,
  // otherwise the ids found in the sidebar (the host resolves their paths).
  useEffect(() => {
    const refs: WorkspaceRef[] =
      items.length > 0
        ? items.map(w => ({ workspaceId: w.workspaceId, path: w.path }))
        : rowIds.map(workspaceId => ({ workspaceId }))
    store.setWorkspaces(refs)
  }, [items, rowIds, store])

  // Find workspace rows and keep one host in every remote workspace row.
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
      if (!binding?.envId || binding.kind !== 'remote') continue
      seen.add(row)
      let trail = hosts.current.get(row)
      if (!trail) {
        trail = makeHost()
        hosts.current.set(row, trail)
      }
      placeTrail(row, trail)
      next.push({ workspaceId, row, trail })
    }
    for (const [row, trail] of hosts.current) {
      if (seen.has(row)) continue
      trail.remove()
      hosts.current.delete(row)
    }
    setDecorations(prev => (sameDecorations(prev, next) ? prev : next))
    setRowIds(prev => (prev.length === ids.length && prev.every((v, i) => v === ids[i]) ? prev : ids))
  }, [])

  useLayoutEffect(() => {
    sync()
  }, [snapshot.byId, sync])

  // Re-sync when the sidebar tree changes.
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
    let frame = 0
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        sync()
      })
    }
    const observer = new MutationObserver(records => {
      for (const r of records) {
        const target = r.target instanceof Element ? r.target : null
        if (target === document.body || target?.closest('[role="tree"]')) {
          schedule()
          return
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    const trails = hosts.current
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      for (const trail of trails.values()) trail.remove()
      trails.clear()
    }
  }, [sync])

  return (
    <>
      {decorations.map(d => {
        const binding = snapshot.byId.get(d.workspaceId)
        if (!binding) return null
        return createPortal(<Tag binding={binding} view={snapshot.view} t={t} />, d.trail, d.workspaceId)
      })}
    </>
  )
}
