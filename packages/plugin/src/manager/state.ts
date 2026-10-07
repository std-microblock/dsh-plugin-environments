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
  /** Explicit mount, or `false` to suppress the remote workspace mount. */
  mount?: SessionMount | false
  /** Why the last mount attempt failed; the session cannot run turns until a retry succeeds. */
  mountError?: string
  borrowable?: string[]
  held?: HeldLease[]
  cwd?: string
  updatedAt?: number
}

export interface WorkspaceSettings {
  /** Default borrowable list of sessions in this workspace (absent: every borrowable environment). */
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
  /** `session`: chosen for the session; `workspace`: its remote workspace. */
  source: 'session' | 'workspace'
  workspace?: string
}

export function emptyState(): PluginState {
  return { version: 1, environments: [], workspaces: {}, sessions: {}, remoteWorkspaces: [] }
}

/** What a workspace is bound to (see `EnvironmentManager.workspaceBinding`). */
export interface WorkspaceBinding {
  /** `remote`: a remote workspace (bound to its environment); `host`: a host workspace. */
  kind: 'remote' | 'host'
  envId?: string | undefined
  remoteRoot?: string | undefined
  remoteWorkspace?: { id: string; title: string } | undefined
  /** The workspace's default borrowable list, when it has one. */
  borrowable?: string[] | undefined
}
