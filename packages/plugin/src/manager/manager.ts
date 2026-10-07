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
  isHeadlessParallel,
  isKind,
  isLeaseMode,
  LOCAL_ID,
  migrateDefinition,
  SECRET_FIELDS,
  SECRET_MARKER,
  slug,
  type DefinitionInput,
  type DiscoveryState,
  type EnvironmentConfig,
  type EnvironmentDefinition,
  type LeaseMode,
  type PublicDefinition,
} from './definitions.ts'
import { Lease, type LeaseOwner, type LeasePurpose, type LeaseRegistry } from './lease.ts'
import {
  emptyState,
  STATE_VERSION,
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
  /** Mode of mounts of environments without their own `mountMode` (default headless). */
  mountMode?: LeaseMode | undefined
}

export interface EnvironmentStatus {
  /** A new headless lease would have to wait (exclusive environment in use). */
  busy: boolean
  /** A new GUI lease (or an upgrade) would have to wait. */
  guiBusy: boolean
  headlessParallel: boolean
  holders: {
    leaseId: string
    sessionId: string | undefined
    title: string | undefined
    purpose: LeasePurpose
    mode: LeaseMode
    guiUsers: string[]
    since: number
  }[]
  /** The lease holding the GUI, if any. */
  gui: { leaseId: string; sessionId: string | undefined; title: string | undefined; users: string[] } | undefined
  queue: { sessionId: string | undefined; since: number; mode: LeaseMode; upgrade: boolean }[]
}

export interface AcquireOptions {
  owner?: LeaseOwner | undefined
  purpose?: LeasePurpose
  /** Lease mode (default headless). A GUI lease's GUI user is the owner's session. */
  mode?: LeaseMode | undefined
  wait?: boolean | undefined
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
  alias?: string | undefined
}

export interface WaitOptions {
  wait?: boolean | undefined
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}

/** A request admitted but not yet turned into a lease (its connection is opening). */
interface Claim {
  mode: LeaseMode
  owner: LeaseOwner | undefined
}

interface Waiter {
  owner: LeaseOwner | undefined
  since: number
  mode: LeaseMode
  /** Set for an upgrade of an existing lease to GUI. */
  lease?: Lease | undefined
  /** Admit the waiter: called synchronously when it reaches the front and fits. */
  wake?: () => void
  cancel?: (error: Error) => void
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
  private readonly claims = new Map<string, Set<Claim>>()
  discovered: DiscoveryState = { adb: [], adbError: undefined, at: 0 }
  private readonly browseConnections = new Map<string, BrowseEntry>()
  private saveTimer: NodeJS.Timeout | undefined
  disposed = false
  /** Listeners and connection pool for reverse environments. */
  readonly reverse: ReverseHub
  private readonly reverseDefaults: ReverseListenerSettings
  /** Mount mode of environments without their own. */
  readonly defaultMountMode: LeaseMode

  constructor({
    dataDir,
    autoDiscoverAdb = true,
    adb = 'adb',
    logger,
    reverse = {},
    mountMode,
  }: EnvironmentManagerOptions) {
    super()
    this.dataDir = dataDir
    this.file = path.join(dataDir, 'environments.json')
    this.autoDiscoverAdb = autoDiscoverAdb
    this.adb = adb
    this.logger = logger
    this.reverseDefaults = reverse
    this.defaultMountMode = isLeaseMode(mountMode) ? mountMode : 'headless'
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
    if (migrateState(this.state)) this.save()
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

  /**
   * The built-in `local` environment: a dsh-env-server child process on the harness host. It is
   * an environment like any other (borrowable, mountable); a session that is not mounted runs on
   * the host itself without it.
   */
  builtinLocal(): EnvironmentDefinition {
    return {
      id: LOCAL_ID,
      name: '本机（独立进程）',
      kind: 'local',
      builtin: true,
      description: os.hostname(),
      config: {},
      borrowable: true,
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

  /** Mode in which mounting occupies an environment. */
  mountModeOf(def: EnvironmentDefinition): LeaseMode {
    return def.mountMode ?? this.defaultMountMode
  }

  /** Public view: secrets are replaced by a marker. */
  publicDef(def: EnvironmentDefinition): PublicDefinition {
    const config: EnvironmentConfig = { ...def.config }
    for (const k of SECRET_FIELDS) if (config[k]) config[k] = SECRET_MARKER
    return {
      ...def,
      config,
      alias: aliasFor(def.id),
      headlessParallel: isHeadlessParallel(def),
      effectiveMountMode: this.mountModeOf(def),
    }
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
    if (input.kind === 'winuser') {
      // Anything but an explicit mode keeps the historical shared-desktop behaviour.
      const mode = config['desktop']
      config['desktop'] = mode === 'private' || mode === 'session' ? mode : 'shared'
    } else {
      delete config['desktop']
    }
    if (config['port'] !== undefined) config['port'] = Number(config['port'])
    const headlessParallel =
      input.headlessParallel === undefined
        ? existing?.headlessParallel
        : input.headlessParallel === false
          ? false
          : undefined
    const mountMode =
      input.mountMode === undefined ? existing?.mountMode : isLeaseMode(input.mountMode) ? input.mountMode : undefined
    const def: EnvironmentDefinition = {
      id,
      name,
      kind: input.kind,
      description: input.description ?? '',
      tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
      borrowable: input.borrowable ?? true,
      ...(headlessParallel === false ? { headlessParallel } : {}),
      ...(mountMode ? { mountMode } : {}),
      // Field values come from the UI form; they are interpreted per kind when opening.
      config,
    }
    if (existing) {
      delete existing.headlessParallel
      delete existing.mountMode
      Object.assign(existing, def)
    } else this.state.environments.push(def)
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
        return openWindowsAccount({
          ...base,
          account: c.account ?? '',
          dataDir: this.dataDir,
          cwd: c.cwd,
          desktop: c.desktop === 'private' || c.desktop === 'session' ? c.desktop : 'shared',
        })
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
  //
  // Admission rules (see README "借用"):
  //
  // | environment             | new headless lease        | new GUI lease / upgrade to GUI           |
  // | ----------------------- | ------------------------- | ---------------------------------------- |
  // | headlessParallel (dflt) | always admitted           | waits while another lease holds the GUI  |
  // | exclusive (false)       | waits while any lease is held (either mode); upgrades of the only lease are immediate |
  //
  // Waiters are served strictly in FIFO order per environment. A request admitted while its
  // connection is still opening counts as a holder (a claim), so nobody slips in meanwhile.

  leasesOf(envId: string): Lease[] {
    return [...this.leases.values()].filter(l => l.envId === envId)
  }

  /** Leases and admitted claims of an environment, except `except`. */
  private holdersOf(envId: string, except?: Lease): { mode: LeaseMode; owner: LeaseOwner | undefined }[] {
    return [...this.leasesOf(envId).filter(l => l !== except), ...(this.claims.get(envId) ?? [])]
  }

  /** Whether a request fits next to the current holders (ignoring the queue). */
  private fits(def: EnvironmentDefinition, mode: LeaseMode, except?: Lease): boolean {
    const others = this.holdersOf(def.id, except)
    if (!isHeadlessParallel(def)) return others.length === 0
    return mode === 'headless' || !others.some(h => h.mode === 'gui')
  }

  /** Whether a waiter queued earlier competes for the same slot (FIFO fairness). */
  private queuedAhead(def: EnvironmentDefinition, mode: LeaseMode, upgrade: boolean): boolean {
    const list = this.waiters.get(def.id) ?? []
    if (!isHeadlessParallel(def)) return !upgrade && list.length > 0
    return mode === 'gui' && list.some(w => w.mode === 'gui')
  }

  private addClaim(envId: string, claim: Claim): void {
    const set = this.claims.get(envId) ?? new Set<Claim>()
    set.add(claim)
    this.claims.set(envId, set)
  }

  private dropClaim(envId: string, claim: Claim): void {
    const set = this.claims.get(envId)
    set?.delete(claim)
    if (set?.size === 0) this.claims.delete(envId)
  }

  /** Who stands in the way of a request, for error messages. */
  private blocker(def: EnvironmentDefinition, mode: LeaseMode, except?: Lease): string {
    const leases = this.leasesOf(def.id).filter(l => l !== except)
    const h = (isHeadlessParallel(def) && mode === 'gui' ? leases.find(l => l.mode === 'gui') : undefined) ?? leases[0]
    const who = h ? (h.owner?.title ?? h.owner?.sessionId ?? 'another session') : 'another session'
    return h ? `${who} (${h.purpose}, ${h.mode})` : `${who} (queued)`
  }

  status(def: EnvironmentDefinition): EnvironmentStatus {
    const leases = this.leasesOf(def.id)
    const guiLease = leases.find(l => l.mode === 'gui')
    return {
      busy: !this.fits(def, 'headless') || this.queuedAhead(def, 'headless', false),
      guiBusy: !this.fits(def, 'gui') || this.queuedAhead(def, 'gui', false),
      headlessParallel: isHeadlessParallel(def),
      holders: leases.map(l => ({
        leaseId: l.id,
        sessionId: l.owner?.sessionId,
        title: l.owner?.title,
        purpose: l.purpose,
        mode: l.mode,
        guiUsers: [...l.guiUsers],
        since: l.createdAt,
      })),
      gui: guiLease
        ? {
            leaseId: guiLease.id,
            sessionId: guiLease.owner?.sessionId,
            title: guiLease.owner?.title,
            users: [...guiLease.guiUsers],
          }
        : undefined,
      queue: (this.waiters.get(def.id) ?? []).map(w => ({
        sessionId: w.owner?.sessionId,
        since: w.since,
        mode: w.mode,
        upgrade: !!w.lease,
      })),
    }
  }

  /**
   * Acquire an environment in a mode (default headless), following the admission rules above.
   * `wait: false` fails with EBUSY instead of queueing.
   */
  async acquire(
    envId: string,
    {
      owner,
      purpose = 'borrow',
      mode = 'headless',
      wait = false,
      timeoutMs = 10 * 60 * 1000,
      signal,
      alias,
    }: AcquireOptions = {},
  ): Promise<Lease> {
    const def = this.require(envId)
    const claim: Claim = { mode, owner }
    if (!this.fits(def, mode) || this.queuedAhead(def, mode, false)) {
      const sid = owner?.sessionId
      if (!isHeadlessParallel(def) && sid && this.leasesOf(def.id).some(l => l.owner?.sessionId === sid))
        throw new EnvError('EEXIST', `this session already holds ${def.name}`)
      if (!wait) {
        throw new EnvError(
          'EBUSY',
          mode === 'gui' && isHeadlessParallel(def)
            ? `the GUI of ${def.name} is in use by ${this.blocker(def, mode)}`
            : `${def.name} is in use by ${this.blocker(def, mode)}`,
        )
      }
      await this.enqueue(def, { owner, mode, timeoutMs, signal, admit: () => this.addClaim(def.id, claim) })
    } else this.addClaim(def.id, claim)
    let env: Environment
    try {
      env = await this.open(def, { signal })
    } catch (e) {
      this.dropClaim(def.id, claim)
      this.wakeNext(def.id)
      throw e
    }
    this.dropClaim(def.id, claim)
    const lease = new Lease(this, {
      id: crypto.randomUUID(),
      def,
      env,
      owner,
      purpose,
      alias: alias ?? aliasFor(def.id),
    })
    if (mode === 'gui') lease.guiUsers.add(guiUserOf(owner, lease))
    this.leases.set(lease.id, lease)
    this.emit('change')
    return lease
  }

  /**
   * Take (`on`) or give up the GUI of a lease for one user (a session id). Taking it is immediate
   * when the lease already is a GUI lease or the GUI is free; otherwise it fails with EBUSY, or
   * queues with `wait: true` like `acquire`. Giving it up never waits; the lease stays headless.
   */
  async setGui(lease: Lease, user: string, on: boolean, { wait = false, timeoutMs, signal }: WaitOptions = {}) {
    if (!on) {
      lease.setGuiUser(user, false)
      return
    }
    if (lease.released) throw new EnvError('ECLOSED', `the lease of ${lease.def.name} was released`)
    if (lease.guiUsers.has(user)) return
    const def = lease.def
    if (lease.mode === 'gui' || (this.fits(def, 'gui', lease) && !this.queuedAhead(def, 'gui', true))) {
      lease.setGuiUser(user, true)
      return
    }
    if (!wait) throw new EnvError('EBUSY', `the GUI of ${def.name} is in use by ${this.blocker(def, 'gui', lease)}`)
    await this.enqueue(def, {
      owner: { ...lease.owner, sessionId: user },
      mode: 'gui',
      lease,
      timeoutMs: timeoutMs ?? 10 * 60 * 1000,
      signal,
      admit: () => lease.setGuiUser(user, true),
    })
  }

  private enqueue(
    def: EnvironmentDefinition,
    {
      owner,
      mode,
      lease,
      timeoutMs,
      signal,
      admit,
    }: {
      owner: LeaseOwner | undefined
      mode: LeaseMode
      lease?: Lease
      timeoutMs: number
      signal: AbortSignal | undefined
      admit: () => void
    },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new EnvError('CANCELLED', 'stopped waiting'))
        return
      }
      const list = this.waiters.get(def.id) ?? []
      this.waiters.set(def.id, list)
      const waiter: Waiter = { owner, since: Date.now(), mode, lease }
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const i = list.indexOf(waiter)
        if (i >= 0) list.splice(i, 1)
        if (list.length === 0 && this.waiters.get(def.id) === list) this.waiters.delete(def.id)
        this.emit('change')
      }
      waiter.cancel = (error: Error) => {
        cleanup()
        reject(error)
        // A waiter that left the front may unblock the ones behind it.
        this.wakeNext(def.id)
      }
      const onAbort = () => waiter.cancel?.(new EnvError('CANCELLED', 'stopped waiting'))
      const timer = setTimeout(
        () => waiter.cancel?.(new EnvError('ETIMEDOUT', `timed out waiting for ${def.name}`)),
        timeoutMs,
      )
      waiter.wake = () => {
        cleanup()
        admit()
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      list.push(waiter)
      this.emit('change')
    })
  }

  /** Admit waiters from the front of the queue while they fit. */
  private wakeNext(envId: string): void {
    const def = this.get(envId)
    const list = this.waiters.get(envId)
    if (!def || !list) return
    for (let first = list[0]; first; first = list[0]) {
      if (first.lease?.released) {
        first.cancel?.(new EnvError('ECLOSED', `the lease of ${def.name} was released`))
        continue
      }
      if (!this.fits(def, first.mode, first.lease)) return
      first.wake?.()
    }
  }

  forgetLease(lease: Lease): void {
    this.leases.delete(lease.id)
  }

  onLeaseReleased(lease: Lease): void {
    this.emit('change')
    this.wakeNext(lease.envId)
  }

  onLeaseModeChanged(lease: Lease): void {
    this.emit('change')
    if (lease.mode === 'headless') this.wakeNext(lease.envId)
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
    for (const list of [...this.waiters.values()])
      for (const w of [...list]) w.cancel?.(new EnvError('CANCELLED', 'the environments plugin is stopping'))
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

/** The GUI user a lease is created with: its owner's session. */
function guiUserOf(owner: LeaseOwner | undefined, lease: Lease): string {
  return owner?.sessionId ?? `lease:${lease.id}`
}

/**
 * Bring loaded state to the current version. Version 2 replaced the `exclusive` flag of
 * definitions by lease modes (`migrateDefinition`). Returns whether anything changed.
 */
export function migrateState(state: PluginState): boolean {
  let changed = false
  for (const def of state.environments) {
    if (def && typeof def === 'object' && migrateDefinition(def as unknown as Record<string, unknown>)) changed = true
  }
  if (state.version !== STATE_VERSION) {
    state.version = STATE_VERSION
    changed = true
  }
  return changed
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
