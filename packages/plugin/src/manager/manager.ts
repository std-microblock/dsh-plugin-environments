// Environment definitions, connections, leases (borrowing) and per-session/workspace settings.
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EnvError, errorMessage, generateSecret } from '@dsh-environments/protocol'
import { AdbEnvironment } from '../env/adb/adb-env.ts'
import { listAdbDevices } from '../env/adb/devices.ts'
import type { Environment } from '../env/environment.ts'
import { openLocal, openServer } from '../env/server/connect.ts'
import { ReverseHub, sanitizeReverseSettings, type ReverseListenerSettings } from '../env/server/reverse.ts'
import { ServerEnvironment } from '../env/server/server-env.ts'
import { openSsh } from '../env/ssh/open.ts'
import { openWindowsAccount } from '../env/winuser/winuser-env.ts'
import type { Logger } from '../host-api.ts'
import {
  aliasFor,
  isExclusive,
  isKind,
  LOCAL_ID,
  SECRET_FIELDS,
  SECRET_MARKER,
  slug,
  defaultExclusive,
  type DefinitionInput,
  type DiscoveryState,
  type EnvironmentConfig,
  type EnvironmentDefinition,
  type PublicDefinition,
} from './definitions.ts'
import { Lease, type LeaseOwner, type LeasePurpose, type LeaseRegistry } from './lease.ts'
import {
  emptyState,
  type EffectiveMount,
  type PluginState,
  type RemoteWorkspace,
  type SessionSettings,
  type WorkspaceBinding,
  type WorkspaceSettings,
} from './state.ts'

export interface EnvironmentManagerOptions {
  dataDir: string
  autoDiscoverAdb?: boolean
  adb?: string
  logger?: Logger | undefined
  /** Reverse-connection listener defaults (until changed in the GUI). */
  reverse?: ReverseListenerSettings | undefined
}

export interface EnvironmentStatus {
  busy: boolean
  holders: {
    leaseId: string
    sessionId: string | undefined
    title: string | undefined
    purpose: LeasePurpose
    since: number
  }[]
  queue: { sessionId: string | undefined; since: number }[]
}

export interface AcquireOptions {
  owner?: LeaseOwner | undefined
  purpose?: LeasePurpose
  wait?: boolean | undefined
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
  alias?: string | undefined
}

interface Waiter {
  owner: LeaseOwner | undefined
  since: number
  wake?: () => void
}

interface BrowseEntry {
  promise: Promise<Environment>
  env?: Environment
  refs: number
  timer?: NodeJS.Timeout
}

export interface ManagerEvents {
  change: []
}

/** Opens an environment for a definition. Replaceable (tests stub it). */
export type EnvironmentOpener = (
  def: EnvironmentDefinition,
  opts?: { signal?: AbortSignal | undefined },
) => Promise<Environment>

export class EnvironmentManager extends EventEmitter<ManagerEvents> implements LeaseRegistry {
  readonly dataDir: string
  readonly file: string
  readonly autoDiscoverAdb: boolean
  readonly adb: string
  readonly logger: Logger | undefined
  state: PluginState = emptyState()
  readonly leases = new Map<string, Lease>()
  private readonly waiters = new Map<string, Waiter[]>()
  discovered: DiscoveryState = { adb: [], adbError: undefined, at: 0 }
  private readonly browseConnections = new Map<string, BrowseEntry>()
  private saveTimer: NodeJS.Timeout | undefined
  disposed = false
  /** Listeners and connection pool for reverse environments. */
  readonly reverse: ReverseHub
  private readonly reverseDefaults: ReverseListenerSettings

  constructor({ dataDir, autoDiscoverAdb = true, adb = 'adb', logger, reverse = {} }: EnvironmentManagerOptions) {
    super()
    this.dataDir = dataDir
    this.file = path.join(dataDir, 'environments.json')
    this.autoDiscoverAdb = autoDiscoverAdb
    this.adb = adb
    this.logger = logger
    this.reverseDefaults = reverse
    this.reverse = new ReverseHub(
      id => {
        const def = this.state.environments.find(e => e.id === id && e.kind === 'reverse')
        return def?.config.token
      },
      msg => this.logger?.info('environments: %s', msg),
    )
    this.reverse.on('change', () => this.emit('change'))
  }

  /** Listener settings in effect: saved from the GUI, else the plugin config. */
  reverseSettings(): ReverseListenerSettings {
    return this.state.reverseListener ?? this.reverseDefaults
  }

  /** Persist and apply new reverse listener settings. */
  async setReverseSettings(settings: ReverseListenerSettings): Promise<void> {
    this.state.reverseListener = settings
    this.save()
    await this.reverse.configure(settings)
  }

  /** Start the reverse listeners configured at load time. */
  async startReverse(): Promise<void> {
    await this.reverse.configure(sanitizeReverseSettings(this.reverseSettings()))
  }

  /** Generate a new secret for a reverse environment, dropping its connections. Returns the secret. */
  rotateReverseSecret(id: string): string {
    const def = this.state.environments.find(e => e.id === id && e.kind === 'reverse')
    if (!def) throw new EnvError('ENOENT', `unknown reverse environment ${id}`)
    def.config.token = generateSecret()
    this.save()
    this.reverse.disconnect(id)
    return def.config.token
  }

  // ---------------------------------------------------------------- persistence

  load(): void {
    fs.mkdirSync(this.dataDir, { recursive: true })
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<PluginState>
      this.state = { ...this.state, ...raw }
    } catch {
      // first run or unreadable state: start empty
    }
    this.state.environments ??= []
    this.state.workspaces ??= {}
    this.state.sessions ??= {}
    this.state.remoteWorkspaces ??= []
    dropRetiredSettings(this.state)
  }

  save(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush(), 50)
    this.saveTimer.unref()
    this.emit('change')
  }

  flush(): void {
    clearTimeout(this.saveTimer)
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (e) {
      this.logger?.warn('environments: cannot save state: %s', errorMessage(e))
    }
  }

  // ---------------------------------------------------------------- definitions

  builtinLocal(): EnvironmentDefinition {
    return {
      id: LOCAL_ID,
      name: '本机',
      kind: 'local',
      builtin: true,
      description: os.hostname(),
      config: {},
      borrowable: true,
      exclusive: false,
    }
  }

  discoveredDefs(): EnvironmentDefinition[] {
    if (!this.autoDiscoverAdb) return []
    const configuredSerials = new Set(this.state.environments.filter(e => e.kind === 'adb').map(e => e.config.serial))
    const taken = new Set(this.state.environments.map(e => e.id))
    return this.discovered.adb
      .filter(d => d.state === 'device' && !configuredSerials.has(d.serial))
      .map(d => {
        let id = `adb_${slug(d.model || d.serial)}`
        if (taken.has(id)) id = `adb_${slug(d.serial)}`
        taken.add(id)
        return {
          id,
          name: d.model ? `${d.model.replace(/_/g, ' ')}${d.emulator ? ' (AVD)' : ''}` : d.serial,
          kind: 'adb',
          discovered: true,
          description: d.serial,
          config: { serial: d.serial },
          borrowable: true,
          exclusive: true,
        }
      })
  }

  definitions(): EnvironmentDefinition[] {
    return [this.builtinLocal(), ...this.state.environments, ...this.discoveredDefs()]
  }

  get(id: string): EnvironmentDefinition | undefined {
    return this.definitions().find(d => d.id === id)
  }

  /** Find a definition by id, name, alias or adb serial; throws ENOENT. */
  require(id: string): EnvironmentDefinition {
    const def =
      this.get(id) ?? this.definitions().find(d => d.name === id || aliasFor(d.id) === id || d.config.serial === id)
    if (!def) throw new EnvError('ENOENT', `unknown environment "${id}"`)
    return def
  }

  /** Like require(), but refreshes device discovery when the id is not known yet. */
  async resolve(id: string): Promise<EnvironmentDefinition> {
    try {
      return this.require(id)
    } catch {
      await this.refreshDiscovery(true)
      return this.require(id)
    }
  }

  /** Persist a discovered device so references to it survive restarts and unplugging. */
  adopt(def: EnvironmentDefinition): EnvironmentDefinition {
    if (!def.discovered) return def
    const { discovered: _discovered, ...rest } = def
    this.state.environments.push(rest)
    this.save()
    return rest
  }

  /** Public view: secrets are replaced by a marker. */
  publicDef(def: EnvironmentDefinition): PublicDefinition {
    const config: EnvironmentConfig = { ...def.config }
    for (const k of SECRET_FIELDS) if (config[k]) config[k] = SECRET_MARKER
    return { ...def, config, alias: aliasFor(def.id), exclusive: isExclusive(def) }
  }

  upsert(input: DefinitionInput): EnvironmentDefinition {
    if (!isKind(input.kind)) throw new EnvError('EINVAL', `unknown kind ${input.kind}`)
    if (input.id === LOCAL_ID) throw new EnvError('EINVAL', 'the local environment is built in')
    const name = String(input.name ?? '').trim() || (input.id ?? '')
    const id = input.id ? String(input.id) : aliasFor(name)
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/.test(id)) throw new EnvError('EINVAL', 'id must be letters, digits, _ . -')
    const existing = this.state.environments.find(e => e.id === id)
    const config: Record<string, unknown> = { ...input.config }
    for (const k of SECRET_FIELDS) {
      if (config[k] === SECRET_MARKER) config[k] = existing?.config[k]
      if (config[k] === '' || config[k] === undefined) delete config[k]
    }
    if (input.kind === 'server' && !config['url'] && (!config['host'] || !config['port']))
      throw new EnvError('EINVAL', 'a URL, or host and port, is required')
    if (input.kind === 'reverse') {
      delete config['host']
      delete config['port']
      config['token'] ??= generateSecret()
    }
    if (input.kind === 'ssh' && !config['host']) throw new EnvError('EINVAL', 'host is required')
    if (input.kind === 'adb' && !config['serial']) throw new EnvError('EINVAL', 'serial is required')
    if (input.kind === 'winuser' && !config['account']) throw new EnvError('EINVAL', 'account is required')
    if (config['port'] !== undefined) config['port'] = Number(config['port'])
    const def: EnvironmentDefinition = {
      id,
      name,
      kind: input.kind,
      description: input.description ?? '',
      tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
      borrowable: input.borrowable ?? true,
      exclusive: input.exclusive ?? defaultExclusive(input.kind),
      // Field values come from the UI form; they are interpreted per kind when opening.
      config,
    }
    if (existing) Object.assign(existing, def)
    else this.state.environments.push(def)
    this.save()
    return def
  }

  remove(id: string): void {
    this.reverse.disconnect(id)
    const before = this.state.environments.length
    this.state.environments = this.state.environments.filter(e => e.id !== id)
    if (this.state.environments.length === before) throw new EnvError('ENOENT', `unknown environment ${id}`)
    this.save()
  }

  async refreshDiscovery(force = false): Promise<DiscoveryState> {
    if (!this.autoDiscoverAdb) return this.discovered
    if (!force && Date.now() - this.discovered.at < 5000) return this.discovered
    try {
      this.discovered = { adb: await listAdbDevices(this.adb), adbError: undefined, at: Date.now() }
    } catch (e) {
      this.discovered = { adb: [], adbError: errorMessage(e), at: Date.now() }
    }
    return this.discovered
  }

  // ---------------------------------------------------------------- connections

  /** Open a fresh connection to an environment. */
  open: EnvironmentOpener = async (def, { signal } = {}) => {
    const base = { id: def.id, name: def.name, signal }
    const c = def.config
    switch (def.kind) {
      case 'local':
        return openLocal({ ...base, cwd: c.cwd || os.homedir() })
      case 'server':
        return c.url
          ? openServer({ ...base, url: c.url, token: c.token })
          : openServer({ ...base, host: c.host ?? '', port: Number(c.port), token: c.token })
      case 'reverse': {
        const transport = await this.reverse.take(def.id, { signal })
        const env = new ServerEnvironment({ id: def.id, name: def.name, kind: 'reverse', transport })
        try {
          return await env.open(signal)
        } catch (e) {
          transport.destroy?.()
          throw e
        }
      }
      case 'ssh':
        return openSsh({ ...base, config: { ...c, host: c.host ?? '' } })
      case 'adb': {
        const env = new AdbEnvironment({ id: def.id, name: def.name, serial: c.serial, adb: c.adb || this.adb })
        return env.open()
      }
      case 'winuser':
        return openWindowsAccount({ ...base, account: c.account ?? '', dataDir: this.dataDir, cwd: c.cwd })
      default:
        throw new EnvError('EINVAL', `unknown environment kind ${String(def.kind)}`)
    }
  }

  /** A cached connection for UI browsing (not a lease). Closed after idle time. */
  async browse<T>(id: string, fn: (env: Environment) => Promise<T>): Promise<T> {
    const def = this.require(id)
    let entry = this.browseConnections.get(id)
    if (!entry || entry.env?.closed) {
      const fresh: BrowseEntry = { promise: this.open(def), refs: 0 }
      entry = fresh
      this.browseConnections.set(id, fresh)
      fresh.promise.then(
        env => {
          fresh.env = env
        },
        () => this.browseConnections.delete(id),
      )
    }
    const current = entry
    current.refs++
    clearTimeout(current.timer)
    try {
      const env = await current.promise
      return await fn(env)
    } finally {
      current.refs--
      if (current.refs === 0) {
        current.timer = setTimeout(() => {
          this.browseConnections.delete(id)
          current.promise.then(
            env => env.close(),
            () => {},
          )
        }, 60000)
        current.timer.unref()
      }
    }
  }

  // ---------------------------------------------------------------- leases

  leasesOf(envId: string): Lease[] {
    return [...this.leases.values()].filter(l => l.envId === envId)
  }

  status(def: EnvironmentDefinition): EnvironmentStatus {
    const leases = this.leasesOf(def.id)
    return {
      busy: isExclusive(def) && leases.length > 0,
      holders: leases.map(l => ({
        leaseId: l.id,
        sessionId: l.owner?.sessionId,
        title: l.owner?.title,
        purpose: l.purpose,
        since: l.createdAt,
      })),
      queue: (this.waiters.get(def.id) ?? []).map(w => ({ sessionId: w.owner?.sessionId, since: w.since })),
    }
  }

  /**
   * Acquire an environment. Exclusive environments admit one lease at a time and queue
   * waiters in FIFO order; `wait: false` fails immediately when busy.
   */
  async acquire(
    envId: string,
    { owner, purpose = 'borrow', wait = false, timeoutMs = 10 * 60 * 1000, signal, alias }: AcquireOptions = {},
  ): Promise<Lease> {
    const def = this.require(envId)
    const sameOwner = (l: Lease) => !!l.owner?.sessionId && l.owner.sessionId === owner?.sessionId
    if (isExclusive(def)) {
      const held = this.leasesOf(def.id)
      const h = held[0]
      if (h) {
        if (held.some(sameOwner) && purpose === 'borrow')
          throw new EnvError('EEXIST', `this session already holds ${def.name}`)
        if (!wait) {
          throw new EnvError(
            'EBUSY',
            `${def.name} is in use by ${h.owner?.title ?? h.owner?.sessionId ?? 'another session'} (${h.purpose})`,
          )
        }
        await this.enqueue(def, { owner, timeoutMs, signal })
      }
    }
    let env: Environment
    try {
      env = await this.open(def, { signal })
    } catch (e) {
      this.wakeNext(def.id)
      throw e
    }
    const lease = new Lease(this, {
      id: crypto.randomUUID(),
      def,
      env,
      owner,
      purpose,
      alias: alias ?? aliasFor(def.id),
    })
    this.leases.set(lease.id, lease)
    this.emit('change')
    return lease
  }

  private enqueue(
    def: EnvironmentDefinition,
    { owner, timeoutMs, signal }: { owner: LeaseOwner | undefined; timeoutMs: number; signal: AbortSignal | undefined },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(def.id) ?? []
      this.waiters.set(def.id, list)
      const waiter: Waiter = { owner, since: Date.now() }
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const i = list.indexOf(waiter)
        if (i >= 0) list.splice(i, 1)
        this.emit('change')
      }
      const onAbort = () => {
        cleanup()
        reject(new EnvError('CANCELLED', 'stopped waiting'))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new EnvError('ETIMEDOUT', `timed out waiting for ${def.name}`))
      }, timeoutMs)
      waiter.wake = () => {
        cleanup()
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      list.push(waiter)
      this.emit('change')
    })
  }

  private wakeNext(envId: string): void {
    const first = this.waiters.get(envId)?.[0]
    const def = this.get(envId)
    if (!first || !def) return
    if (this.status(def).busy) return
    first.wake?.()
  }

  forgetLease(lease: Lease): void {
    this.leases.delete(lease.id)
  }

  onLeaseReleased(lease: Lease): void {
    this.emit('change')
    this.wakeNext(lease.envId)
  }

  async releaseAll(predicate: (lease: Lease) => boolean = () => true): Promise<void> {
    await Promise.all([...this.leases.values()].filter(predicate).map(l => l.release('released')))
  }

  // ---------------------------------------------------------------- session / workspace settings

  normPath(p: string): string
  normPath(p: string | undefined): string | undefined
  normPath(p: string | undefined): string | undefined {
    if (!p) return p
    const r = path.resolve(p)
    return process.platform === 'win32' ? r.toLowerCase() : r
  }

  workspaceSettings(hostPath: string | undefined): WorkspaceSettings {
    return this.state.workspaces[String(this.normPath(hostPath))] ?? {}
  }

  /**
   * Merge a patch into a workspace's settings. Keys absent from the patch are kept; keys
   * present with `undefined`/`null` are cleared. Empty settings are dropped from the state.
   */
  setWorkspaceSettings(
    hostPath: string,
    patch: { [K in keyof WorkspaceSettings]?: WorkspaceSettings[K] | null },
  ): WorkspaceSettings {
    const key = this.normPath(hostPath)
    const next: Record<string, unknown> = { ...this.state.workspaces[key] }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null) delete next[k]
      else next[k] = v
    }
    const settings = next as WorkspaceSettings
    if (Object.keys(settings).length === 0) delete this.state.workspaces[key]
    else this.state.workspaces[key] = settings
    this.save()
    return settings
  }

  /**
   * What a workspace is bound to: a remote workspace is bound to its environment, any other
   * workspace runs on the host.
   */
  workspaceBinding(hostPath: string, workspaceId?: string): WorkspaceBinding {
    const remote =
      (workspaceId ? this.state.remoteWorkspaces.find(w => w.workspaceId === workspaceId) : undefined) ??
      this.remoteWorkspaceFor(hostPath)
    const settings = this.workspaceSettings(remote?.hostPath ?? hostPath)
    const borrowable = Array.isArray(settings.borrowable) ? settings.borrowable : undefined
    if (remote) {
      return {
        kind: 'remote',
        envId: remote.envId,
        remoteRoot: remote.root,
        remoteWorkspace: { id: remote.id, title: remote.title },
        borrowable,
      }
    }
    return { kind: 'host', borrowable }
  }

  sessionSettings(sessionId: string): SessionSettings {
    return this.state.sessions[sessionId] ?? {}
  }

  /** Merge a patch into a session's settings; `undefined`/`null` values delete keys. */
  setSessionSettings(
    sessionId: string,
    patch: { [K in keyof SessionSettings]?: SessionSettings[K] | null | undefined },
  ): SessionSettings {
    const next: Record<string, unknown> = { ...this.state.sessions[sessionId], ...patch, updatedAt: Date.now() }
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null) delete next[k]
    const settings = next as SessionSettings
    this.state.sessions[sessionId] = settings
    this.save()
    return settings
  }

  /** Remote workspace whose host placeholder contains (or equals) the given host directory. */
  remoteWorkspaceFor(hostPath: string | undefined): RemoteWorkspace | undefined {
    if (!hostPath) return undefined
    const p = this.normPath(hostPath)
    return this.state.remoteWorkspaces.find(w => {
      const h = this.normPath(w.hostPath)
      return p === h || p.startsWith(h + path.sep)
    })
  }

  /**
   * Mount effective for a session: its own choice (`false` turns the remote workspace mount
   * off), else its remote workspace.
   */
  mountFor(sessionId: string, cwd: string | undefined): EffectiveMount | undefined {
    const s = this.sessionSettings(sessionId)
    if (s.mount === false) return undefined
    if (s.mount?.envId) return { ...s.mount, hostRoot: s.mount.hostRoot ?? cwd, source: 'session' }
    const ws = this.remoteWorkspaceFor(cwd)
    if (ws)
      return { envId: ws.envId, remoteRoot: ws.root, hostRoot: ws.hostPath, source: 'workspace', workspace: ws.id }
    return undefined
  }

  /** Environments a session may borrow: session list, else workspace list, else every borrowable env. */
  borrowableFor(
    sessionId: string,
    cwd: string | undefined,
  ): { source: 'all' | 'session' | 'workspace'; defs: EnvironmentDefinition[] } {
    const s = this.sessionSettings(sessionId)
    let ids = s.borrowable
    let source: 'session' | 'workspace' = 'session'
    if (!Array.isArray(ids)) {
      const ws = this.remoteWorkspaceFor(cwd)
      const wsSettings = this.workspaceSettings(ws?.hostPath ?? cwd)
      ids = wsSettings.borrowable
      source = 'workspace'
    }
    const defs = this.definitions().filter(d => d.borrowable !== false)
    if (!Array.isArray(ids)) return { source: 'all', defs }
    const set = new Set(ids)
    return { source, defs: defs.filter(d => set.has(d.id)) }
  }

  addRemoteWorkspace({
    envId,
    root,
    title,
    mountsDir,
  }: {
    envId: string
    root: string
    title?: string | undefined
    mountsDir: string
  }): RemoteWorkspace {
    const def = this.require(envId)
    const id = crypto.randomUUID().slice(0, 8)
    const base = path.posix.basename(root.replace(/\\/g, '/'))
    const name = `${slug(def.id)}-${slug(base || 'root')}-${id}`
    const hostPath = path.join(mountsDir, name)
    fs.mkdirSync(hostPath, { recursive: true })
    fs.writeFileSync(
      path.join(hostPath, '.dsh-environment-mount.json'),
      JSON.stringify(
        {
          envId,
          root,
          note: 'Placeholder for a remote workspace mounted by dsh-plugin-environments. Files live in the environment.',
        },
        null,
        2,
      ),
    )
    const ws: RemoteWorkspace = {
      id,
      envId,
      root,
      title: title || `${base || root} @ ${def.name}`,
      hostPath,
      createdAt: Date.now(),
    }
    this.state.remoteWorkspaces.push(ws)
    this.save()
    return ws
  }

  removeRemoteWorkspace(id: string): RemoteWorkspace | undefined {
    const ws = this.state.remoteWorkspaces.find(w => w.id === id)
    this.state.remoteWorkspaces = this.state.remoteWorkspaces.filter(w => w.id !== id)
    this.save()
    return ws
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.flush()
    for (const list of this.waiters.values()) for (const w of [...list]) w.wake?.()
    await this.releaseAll()
    for (const entry of this.browseConnections.values()) {
      clearTimeout(entry.timer)
      entry.promise.then(
        env => env.close(),
        () => {},
      )
    }
    this.browseConnections.clear()
    await this.reverse.dispose()
  }
}

/**
 * Drop settings of retired features from loaded state: the workspace default environment
 * (`defaultMount`) and the marker of session mounts seeded from it (`mountOrigin`). Such a
 * session keeps its mount, now as an ordinary session mount.
 */
export function dropRetiredSettings(state: PluginState): void {
  for (const [key, settings] of Object.entries(state.workspaces)) {
    if (!settings || typeof settings !== 'object') continue
    const record = settings as Record<string, unknown>
    if (!('defaultMount' in record)) continue
    delete record['defaultMount']
    if (Object.keys(record).length === 0) delete state.workspaces[key]
  }
  for (const settings of Object.values(state.sessions)) {
    if (settings && typeof settings === 'object') delete (settings as Record<string, unknown>)['mountOrigin']
  }
}
