// Shared, polled view of the workspace ↔ environment bindings shown in the DSH sidebar.
import { call, isUnknownAction, messageOf, onInvalidate } from './api.ts'
import { bindingsFromState, bindingsById, workspacesKey, type WorkspaceRef } from './binding-logic.ts'
import type { BindingView, BindingsView, StateView } from './types.ts'

export interface BindingsSnapshot {
  /** `false` when the running host plugin predates `workspace.bindings` (remote workspaces only). */
  supported: boolean | undefined
  view: BindingsView | undefined
  byId: Map<string, BindingView>
  error: string | undefined
}

const INTERVAL_MS = 10000

/**
 * One store per client module: the sidebar decorations, the workspace-settings dialog and the
 * menu item all read it. It polls while someone is subscribed and the tab is visible, and
 * refreshes at once after any mutation in this GUI (`invalidate()`).
 */
export class BindingsStore {
  private snapshot: BindingsSnapshot = { supported: undefined, view: undefined, byId: new Map(), error: undefined }
  private readonly listeners = new Set<() => void>()
  private workspaces: WorkspaceRef[] = []
  private key = ''
  private timer: ReturnType<typeof setTimeout> | undefined
  private inflight: AbortController | undefined
  private stopInvalidate: (() => void) | undefined
  private seq = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.start()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }

  getSnapshot = (): BindingsSnapshot => this.snapshot

  /** The workspaces currently listed; a change refetches immediately. */
  setWorkspaces(workspaces: readonly WorkspaceRef[]): void {
    const key = workspacesKey(workspaces)
    if (key === this.key) return
    this.key = key
    this.workspaces = [...workspaces]
    if (this.listeners.size > 0) this.refresh()
  }

  refresh = (): void => {
    clearTimeout(this.timer)
    this.inflight?.abort()
    const controller = new AbortController()
    this.inflight = controller
    const mine = ++this.seq
    void this.load(controller.signal)
      .then(
        next => {
          if (mine === this.seq) this.set(next)
        },
        (error: unknown) => {
          if (mine === this.seq && !controller.signal.aborted) this.set({ ...this.snapshot, error: messageOf(error) })
        },
      )
      .finally(() => {
        if (mine !== this.seq || this.listeners.size === 0) return
        this.timer = setTimeout(() => {
          if (typeof document === 'undefined' || document.visibilityState === 'visible') this.refresh()
          else this.timer = setTimeout(this.refresh, INTERVAL_MS)
        }, INTERVAL_MS)
      })
  }

  private async load(signal: AbortSignal): Promise<BindingsSnapshot> {
    const workspaces = this.workspaces
    if (workspaces.length === 0) {
      return { ...this.snapshot, view: { bindings: [], availability: {}, environments: [] }, byId: new Map() }
    }
    if (this.snapshot.supported !== false) {
      try {
        const view = await call<BindingsView>('workspace.bindings', { workspaces }, signal)
        return { supported: true, view, byId: bindingsById(view), error: undefined }
      } catch (error) {
        if (!isUnknownAction(error)) throw error
      }
    }
    // Older host plugin: derive what can be derived from the general state.
    const state = await call<StateView>('state', {}, signal)
    const view = bindingsFromState(state, workspaces)
    return { supported: false, view, byId: bindingsById(view), error: undefined }
  }

  private set(next: BindingsSnapshot): void {
    this.snapshot = next
    for (const l of this.listeners) l()
  }

  private start(): void {
    this.stopInvalidate = onInvalidate(this.refresh)
    this.refresh()
  }

  private stop(): void {
    this.stopInvalidate?.()
    this.stopInvalidate = undefined
    clearTimeout(this.timer)
    this.inflight?.abort()
    this.seq++
  }
}
