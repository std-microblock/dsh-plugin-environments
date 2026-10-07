// Pure helpers for workspace ↔ environment bindings (no React, no DOM: unit-tested under Node).
import type { AvailabilityState, AvailabilityView, BindingView, BindingsView, StateView } from './types.ts'

/** A workspace as the GUI lists it. */
export interface WorkspaceRef {
  workspaceId: string
  path?: string | undefined
}

/** Prefix of the `data-row-key` attribute of a workspace header row in the DSH sidebar. */
export const WORKSPACE_ROW_PREFIX = 'workspace:'

/** Workspace id of a sidebar row key (`workspace:<id>`); undefined for other rows and the ungrouped bucket. */
export function workspaceIdOfRowKey(key: string | null | undefined): string | undefined {
  if (!key?.startsWith(WORKSPACE_ROW_PREFIX)) return undefined
  const id = key.slice(WORKSPACE_ROW_PREFIX.length)
  return id || undefined
}

/** Comparable form of a host path (Windows paths compare case-insensitively, either slash). */
export function pathKey(p: string | undefined): string {
  if (!p) return ''
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(p)
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return windows ? s.toLowerCase() : s
}

/** States marked with a red dot. */
export function isUnavailable(state: AvailabilityState | undefined): boolean {
  return state === 'offline' || state === 'error'
}

/**
 * Bindings derived from the `state` action, for a host plugin that predates `workspace.bindings`:
 * remote workspaces, adb availability from discovery, others unknown.
 */
export function bindingsFromState(state: StateView, workspaces: readonly WorkspaceRef[]): BindingsView {
  const bindings: BindingView[] = []
  for (const ws of workspaces) {
    const remote = state.remoteWorkspaces.find(
      r =>
        (r.workspaceId !== undefined && r.workspaceId === ws.workspaceId) ||
        (!!ws.path && pathKey(r.hostPath) === pathKey(ws.path)),
    )
    if (!remote) continue
    bindings.push({
      workspaceId: ws.workspaceId,
      path: ws.path ?? remote.hostPath,
      kind: 'remote',
      envId: remote.envId,
      remoteRoot: remote.root,
      remoteWorkspace: { id: remote.id, title: remote.title },
    })
  }
  const availability: Record<string, AvailabilityView> = {}
  const devices = (state.discovered.adb as { serial?: unknown; state?: unknown }[]).filter(
    d => !!d && typeof d === 'object',
  )
  const environments: BindingsView['environments'] = []
  for (const id of new Set(bindings.flatMap(b => (b.envId ? [b.envId] : [])))) {
    const env = state.environments.find(e => e.id === id)
    if (!env) {
      availability[id] = { state: 'error', reason: `unknown environment "${id}"` }
      continue
    }
    environments.push({ id: env.id, name: env.name, kind: env.kind })
    if (env.kind === 'local') availability[id] = { state: 'available' }
    else if (env.kind === 'adb' && !state.discovered.adbError) {
      const d = devices.find(x => x.serial === env.config.serial)
      availability[id] =
        d?.state === 'device'
          ? { state: 'available' }
          : { state: 'offline', reason: d ? `device is ${String(d.state)}` : 'device not connected' }
    } else availability[id] = { state: env.status?.busy ? 'busy' : 'unknown' }
  }
  return { bindings, availability, environments }
}

/** Index bindings by workspace id. */
export function bindingsById(view: BindingsView | undefined): Map<string, BindingView> {
  const map = new Map<string, BindingView>()
  for (const b of view?.bindings ?? []) if (b.workspaceId) map.set(b.workspaceId, b)
  return map
}

/** Stable identity of a workspace list (to skip refetching when nothing changed). */
export function workspacesKey(workspaces: readonly WorkspaceRef[]): string {
  return workspaces.map(w => `${w.workspaceId}\u0000${w.path ?? ''}`).join('\u0001')
}
