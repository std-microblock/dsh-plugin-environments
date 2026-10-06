// Persisted plugin state (environments.json).
import type { ReverseListenerSettings } from '../env/server/reverse.ts'
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
  /** Explicit mount, or `false` to suppress the workspace mount. */
  mount?: SessionMount | false
  mountError?: string
  borrowable?: string[]
  held?: HeldLease[]
  cwd?: string
  updatedAt?: number
}

export interface WorkspaceSettings {
  borrowable?: string[] | undefined
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
  /** Listeners for reverse connections (`dsh-env-server connect`); absent = plugin config defaults. */
  reverseListener?: ReverseListenerSettings
}

/** The mount effective for a session, and where it came from. */
export interface EffectiveMount {
  envId: string
  remoteRoot?: string | undefined
  hostRoot?: string | undefined
  source: 'session' | 'workspace'
  workspace?: string
}

export function emptyState(): PluginState {
  return { version: 1, environments: [], workspaces: {}, sessions: {}, remoteWorkspaces: [] }
}
