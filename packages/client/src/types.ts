// Shapes of the plugin HTTP API responses as consumed by the GUI.
// They mirror packages/plugin/src/api/actions.ts; fields the GUI does not read are omitted.

export type EnvKind = 'local' | 'server' | 'ssh' | 'adb' | 'winuser' | 'reverse'

export interface EnvConfigView {
  host?: string
  port?: number | string
  url?: string
  token?: string
  username?: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
  cwd?: string
  serverPath?: string
  serial?: string
  account?: string
  /** winuser: `shared` (the human's desktop), `private` (own desktop) or `session` */
  desktop?: 'shared' | 'private' | 'session'
}

export interface InfoView {
  os: string
  family: string
  arch: string
  hostname: string
  user: string
  home: string
  cwd: string
  shell: string
  caps: string[]
  version: string
  pathSep: string
}

export interface EnvStatusView {
  busy: boolean
  holders?: { leaseId: string; sessionId?: string; title?: string; purpose: string; since: number }[]
  queue?: { sessionId?: string; since: number }[]
}

export interface EnvView {
  id: string
  name: string
  kind: EnvKind
  alias: string
  description?: string
  exclusive: boolean
  borrowable?: boolean
  builtin?: boolean
  discovered?: boolean
  config: EnvConfigView
  status?: EnvStatusView
  info?: InfoView
  lastError?: string
  /** reverse environments: connections dialed in by the remote server */
  connection?: ReverseConnectionView
}

export interface ReverseConnectionView {
  idle: number
  active: number
  peer?: string
  since?: number
}

export interface ListenerStatusView {
  enabled: boolean
  listening: boolean
  host: string
  port: number
  path?: string
  error?: string
}

export interface ReverseSettingsView {
  tcp?: { enabled?: boolean; host?: string; port?: number }
  ws?: { enabled?: boolean; host?: string; port?: number; path?: string }
  publicHost?: string
}

export interface ReverseStatusView {
  tcp: ListenerStatusView
  ws: ListenerStatusView
  publicHost: string
}

/** Returned once when a reverse environment's secret is created or rotated. */
export interface ReverseRevealView {
  secret: string
  urls: string[]
  posix?: string
  windows?: string
}

export interface RemoteWorkspaceView {
  id: string
  envId: string
  root: string
  title: string
  hostPath: string
  workspaceId?: string
}

export interface LeaseView {
  id: string
  envId: string
  alias: string
  name: string
  purpose: string
  owner?: { sessionId?: string; title?: string; reason?: string }
  createdAt: number
  tunnels?: unknown[]
}

export interface SessionView {
  sessionId: string
  live: boolean
  cwd?: string
  mount?: { envId: string; remoteRoot?: string; source: 'session' | 'workspace' }
  mountExplicitlyOff: boolean
  mountActive?: { envId: string; remoteRoot: string; since: number }
  mountError?: string
  /** Set while the session cannot run because its mount is missing ("环境 X 挂载失败：…"). */
  mountBlocked?: string
  borrowableSource: 'all' | 'session' | 'workspace'
  borrowable: string[]
  borrowableExplicit?: string[]
  held: (LeaseView & { tools: number })[]
  started: boolean
}

export interface StateView {
  platform: string
  environments: EnvView[]
  discovered: { adb: unknown[]; adbError?: string }
  remoteWorkspaces: RemoteWorkspaceView[]
  leases: LeaseView[]
  session?: SessionView
}

export interface DirEntryView {
  name: string
  type: 'file' | 'dir' | 'symlink' | 'other'
  size?: number
  mtimeMs?: number
}

export interface ListingView {
  path: string
  parent?: string
  entries: DirEntryView[]
  sep?: string
  home?: string
  cwd?: string
}

export interface TestResultView {
  ok: boolean
  error?: string
  ms?: number
  info?: InfoView
}

export interface CreatedWorkspaceView {
  workspace: RemoteWorkspaceView
  workspaceId?: string
}

export type AvailabilityState = 'available' | 'busy' | 'offline' | 'error' | 'unknown'

export interface AvailabilityView {
  state: AvailabilityState
  reason?: string
  checkedAt?: number
}

/** What one workspace is bound to (`workspace.bindings`). */
export interface BindingView {
  workspaceId?: string
  path: string
  /** `remote`: a remote workspace (bound to its environment); `host`: a host workspace. */
  kind: 'remote' | 'host'
  envId?: string
  remoteRoot?: string
  remoteWorkspace?: { id: string; title: string }
  borrowable?: string[]
}

export interface BindingsView {
  bindings: BindingView[]
  availability: Record<string, AvailabilityView>
  environments: { id: string; name: string; kind: EnvKind }[]
}
