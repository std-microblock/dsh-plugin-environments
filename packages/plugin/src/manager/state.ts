// Persisted plugin state (environments.json).
import type { EnvironmentDefinition } from './definitions.ts'

/** Mount requested for a session. */
export interface SessionMount {
  envId: string
  remoteRoot?: string | undefined
  hostRoot?: string | undefined
}

/** A lease to re-acquire when the session resumes. */
export interface HeldLease {
  envId: string
  alias: string
}

export interface SessionSettings {
  /** Explicit mount, or `false` to suppress the workspace mount (remote workspace or workspace default). */
  mount?: SessionMount | false
  /** `default` when `mount` was seeded from the workspace's default environment rather than chosen. */
  mountOrigin?: 'default'
  mountError?: string
  borrowable?: string[]
  held?: HeldLease[]
  cwd?: string
  updatedAt?: number
}

export interface WorkspaceSettings {
  /** Default borrowable list of sessions in this workspace (absent: every borrowable environment). */
  borrowable?: string[] | undefined
  /**
   * Default environment of this (host) workspace: new sessions started here are mounted onto it,
   * at `remoteRoot` (absent: the environment's own working directory). Ignored for remote
   * workspaces, which are always bound to their own environment.
   */
  defaultMount?: WorkspaceDefaultMount | undefined
}

/** A workspace's default environment. */
export interface WorkspaceDefaultMount {
  envId: string
  remoteRoot?: string | undefined
}

/** A remote directory registered as a DSH workspace through a host placeholder directory. */
export interface RemoteWorkspace {
  id: string
  envId: string
  root: string
  title: string
  hostPath: string
  createdAt: number
  workspaceId?: string
}

export interface PluginState {
  version: number
  environments: EnvironmentDefinition[]
  workspaces: Record<string, WorkspaceSettings>
  sessions: Record<string, SessionSettings>
  remoteWorkspaces: RemoteWorkspace[]
}

/** The mount effective for a session, and where it came from. */
export interface EffectiveMount {
  envId: string
  remoteRoot?: string | undefined
  hostRoot?: string | undefined
  /** `session`: chosen for the session; `workspace`: its remote workspace; `default`: the workspace's default environment. */
  source: 'session' | 'workspace' | 'default'
  workspace?: string
}

export function emptyState(): PluginState {
  return { version: 1, environments: [], workspaces: {}, sessions: {}, remoteWorkspaces: [] }
}

/** What a workspace is bound to (see `EnvironmentManager.workspaceBinding`). */
export interface WorkspaceBinding {
  /** `remote`: a remote workspace; `default`: a host workspace with a default environment; `host`: neither. */
  kind: 'remote' | 'default' | 'host'
  envId?: string | undefined
  remoteRoot?: string | undefined
  remoteWorkspace?: { id: string; title: string } | undefined
  /** The workspace's default borrowable list, when it has one. */
  borrowable?: string[] | undefined
}
