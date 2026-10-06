// Environment definitions, connections, leases (borrowing) and per-session/workspace settings.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { EnvError } from './protocol/client.js'
import { openLocal, openServer } from './env/connect.js'
import { AdbEnvironment, listAdbDevices } from './env/adb-env.js'
import { openSsh } from './env/ssh-env.js'
import { openWindowsAccount } from './env/winuser-env.js'

export const KINDS = ['local', 'server', 'ssh', 'adb', 'winuser']
const SECRET_FIELDS = ['token', 'password', 'passphrase']
export const LOCAL_ID = 'local'

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'env'
}

/** Tool-name-safe alias for an environment. */
export function aliasFor(id) {
  let a = slug(id)
  if (!/^[a-z]/.test(a)) a = `env_${a}`
  return a
}

function defaultExclusive(kind) {
  return kind === 'adb' || kind === 'winuser'
}

/**
 * One borrow (or mount) of an environment. The holder owns an independent connection;
 * releasing closes it together with every tunnel and process opened through it.
 */
export class Lease extends EventEmitter {
  constructor(manager, { id, def, env, owner, purpose, alias }) {
    super()
    this.manager = manager
    this.id = id
    this.def = def
    this.env = env
    this.owner = owner
    this.purpose = purpose
    this.alias = alias
    this.createdAt = Date.now()
    this.released = false
    env.once('close', () => this.release('connection lost'))
  }

  get envId() {
    return this.def.id
  }

  async release(reason = 'returned') {
    if (this.released) return
    this.released = true
    this.manager.leases.delete(this.id)
    this.emit('release', reason)
    try {
      await this.env.close()
    } catch {}
    this.manager.onLeaseReleased(this)
  }

  describe() {
    return {
      id: this.id,
      envId: this.envId,
      alias: this.alias,
      purpose: this.purpose,
      owner: this.owner,
      createdAt: this.createdAt,
      tunnels: this.env.listTunnels?.() ?? [],
    }
  }
}

export class EnvironmentManager extends EventEmitter {
  constructor({ dataDir, autoDiscoverAdb = true, adb = 'adb', logger } = {}) {
    super()
    this.dataDir = dataDir
    this.file = path.join(dataDir, 'environments.json')
    this.autoDiscoverAdb = autoDiscoverAdb
    this.adb = adb
    this.logger = logger
    this.state = { version: 1, environments: [], workspaces: {}, sessions: {}, remoteWorkspaces: [] }
    this.leases = new Map()
    this.waiters = new Map()
    this.discovered = { adb: [], adbError: undefined, at: 0 }
    this.browseConnections = new Map()
    this.disposed = false
  }

  // ---------------------------------------------------------------- persistence

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true })
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.state = { ...this.state, ...raw }
    } catch {}
    this.state.environments ??= []
    this.state.workspaces ??= {}
    this.state.sessions ??= {}
    this.state.remoteWorkspaces ??= []
  }

  save() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush(), 50)
    this.saveTimer.unref?.()
    this.emit('change')
  }

  flush() {
    clearTimeout(this.saveTimer)
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (e) {
      this.logger?.warn?.('environments: cannot save state: %s', e.message)
    }
  }

  // ---------------------------------------------------------------- definitions

  builtinLocal() {
    return { id: LOCAL_ID, name: '本机', kind: 'local', builtin: true, description: os.hostname(), config: {}, borrowable: true, exclusive: false }
  }

  discoveredDefs() {
    if (!this.autoDiscoverAdb) return []
    const configuredSerials = new Set(this.state.environments.filter(e => e.kind === 'adb').map(e => e.config?.serial))
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

  definitions() {
    return [this.builtinLocal(), ...this.state.environments, ...this.discoveredDefs()]
  }

  get(id) {
    return this.definitions().find(d => d.id === id)
  }

  require(id) {
    const def = this.get(id) ?? this.definitions().find(d => d.name === id || aliasFor(d.id) === id || d.config?.serial === id)
    if (!def) throw new EnvError('ENOENT', `unknown environment "${id}"`)
    return def
  }

  /** Like require(), but refreshes device discovery when the id is not known yet. */
  async resolve(id) {
    try {
      return this.require(id)
    } catch (e) {
      await this.refreshDiscovery(true)
      return this.require(id)
    }
  }

  /** Persist a discovered device so references to it survive restarts and unplugging. */
  adopt(def) {
    if (!def.discovered) return def
    const { discovered, ...rest } = def
    this.state.environments.push(rest)
    this.save()
    return rest
  }

  /** Public view: secrets are replaced by a marker. */
  publicDef(def) {
    const config = { ...def.config }
    for (const k of SECRET_FIELDS) if (config[k]) config[k] = '••••••'
    return { ...def, config, alias: aliasFor(def.id), exclusive: def.exclusive ?? defaultExclusive(def.kind) }
  }

  upsert(input) {
    if (!KINDS.includes(input.kind)) throw new EnvError('EINVAL', `unknown kind ${input.kind}`)
    if (input.id === LOCAL_ID) throw new EnvError('EINVAL', 'the local environment is built in')
    const name = String(input.name ?? '').trim() || input.id
    let id = input.id ? String(input.id) : aliasFor(name)
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/.test(id)) throw new EnvError('EINVAL', 'id must be letters, digits, _ . -')
    const existing = this.state.environments.find(e => e.id === id)
    const config = { ...input.config }
    for (const k of SECRET_FIELDS) {
      if (config[k] === '••••••') config[k] = existing?.config?.[k]
      if (config[k] === '' || config[k] === undefined) delete config[k]
    }
    if (input.kind === 'server' && (!config.host || !config.port)) throw new EnvError('EINVAL', 'host and port are required')
    if (input.kind === 'ssh' && !config.host) throw new EnvError('EINVAL', 'host is required')
    if (input.kind === 'adb' && !config.serial) throw new EnvError('EINVAL', 'serial is required')
    if (input.kind === 'winuser' && !config.account) throw new EnvError('EINVAL', 'account is required')
    if (config.port !== undefined) config.port = Number(config.port)
    const def = {
      id, name, kind: input.kind,
      description: input.description ?? '',
      tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
      borrowable: input.borrowable ?? true,
      exclusive: input.exclusive ?? defaultExclusive(input.kind),
      config,
    }
    if (existing) Object.assign(existing, def)
    else this.state.environments.push(def)
    this.save()
    return def
  }

  remove(id) {
    const before = this.state.environments.length
    this.state.environments = this.state.environments.filter(e => e.id !== id)
    if (this.state.environments.length === before) throw new EnvError('ENOENT', `unknown environment ${id}`)
    this.save()
  }

  async refreshDiscovery(force = false) {
    if (!this.autoDiscoverAdb) return this.discovered
    if (!force && Date.now() - this.discovered.at < 5000) return this.discovered
    try {
      this.discovered = { adb: await listAdbDevices(this.adb), adbError: undefined, at: Date.now() }
    } catch (e) {
      this.discovered = { adb: [], adbError: e.message, at: Date.now() }
    }
    return this.discovered
  }

  // ---------------------------------------------------------------- connections

  /** Open a fresh connection to an environment. */
  async open(def, { signal } = {}) {
    const base = { id: def.id, name: def.name, signal }
    const c = def.config ?? {}
    switch (def.kind) {
      case 'local':
        return openLocal({ ...base, cwd: c.cwd || os.homedir() })
      case 'server':
        return openServer({ ...base, host: c.host, port: Number(c.port), token: c.token })
      case 'ssh':
        return openSsh({ ...base, config: c })
      case 'adb': {
        const env = new AdbEnvironment({ id: def.id, name: def.name, serial: c.serial, adb: c.adb || this.adb })
        return env.open()
      }
      case 'winuser':
        return openWindowsAccount({ ...base, account: c.account, dataDir: this.dataDir, cwd: c.cwd })
      default:
        throw new EnvError('EINVAL', `unknown environment kind ${def.kind}`)
    }
  }

  /** A cached connection for UI browsing (not a lease). Closed after idle time. */
  async browse(id, fn) {
    const def = this.require(id)
    let entry = this.browseConnections.get(id)
    if (!entry || entry.env?.closed) {
      entry = { promise: this.open(def), refs: 0 }
      this.browseConnections.set(id, entry)
      entry.promise.then(env => { entry.env = env }, () => this.browseConnections.delete(id))
    }
    entry.refs++
    clearTimeout(entry.timer)
    try {
      const env = await entry.promise
      return await fn(env)
    } finally {
      entry.refs--
      if (entry.refs === 0) {
        entry.timer = setTimeout(() => {
          this.browseConnections.delete(id)
          entry.promise.then(env => env.close(), () => {})
        }, 60000)
        entry.timer.unref?.()
      }
    }
  }

  // ---------------------------------------------------------------- leases

  leasesOf(envId) {
    return [...this.leases.values()].filter(l => l.envId === envId)
  }

  status(def) {
    const leases = this.leasesOf(def.id)
    const exclusive = def.exclusive ?? defaultExclusive(def.kind)
    return {
      busy: exclusive && leases.length > 0,
      holders: leases.map(l => ({ leaseId: l.id, sessionId: l.owner?.sessionId, title: l.owner?.title, purpose: l.purpose, since: l.createdAt })),
      queue: (this.waiters.get(def.id) ?? []).map(w => ({ sessionId: w.owner?.sessionId, since: w.since })),
    }
  }

  /**
   * Acquire an environment. Exclusive environments admit one lease at a time and queue
   * waiters in FIFO order; `wait: false` fails immediately when busy.
   */
  async acquire(envId, { owner, purpose = 'borrow', wait = false, timeoutMs = 10 * 60 * 1000, signal, alias } = {}) {
    const def = this.require(envId)
    const exclusive = def.exclusive ?? defaultExclusive(def.kind)
    const sameOwner = l => l.owner?.sessionId && l.owner.sessionId === owner?.sessionId
    if (exclusive) {
      const held = this.leasesOf(def.id)
      if (held.length > 0) {
        if (held.some(sameOwner) && purpose === 'borrow') throw new EnvError('EEXIST', `this session already holds ${def.name}`)
        if (!wait) {
          const h = held[0]
          throw new EnvError('EBUSY', `${def.name} is in use by ${h.owner?.title ?? h.owner?.sessionId ?? 'another session'} (${h.purpose})`)
        }
        await this.enqueue(def, { owner, timeoutMs, signal })
      }
    }
    let env
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

  enqueue(def, { owner, timeoutMs, signal }) {
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(def.id) ?? []
      this.waiters.set(def.id, list)
      const waiter = { owner, since: Date.now() }
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const i = list.indexOf(waiter)
        if (i >= 0) list.splice(i, 1)
        this.emit('change')
      }
      const onAbort = () => { cleanup(); reject(new EnvError('CANCELLED', 'stopped waiting')) }
      const timer = setTimeout(() => { cleanup(); reject(new EnvError('ETIMEDOUT', `timed out waiting for ${def.name}`)) }, timeoutMs)
      waiter.wake = () => { cleanup(); resolve() }
      signal?.addEventListener('abort', onAbort, { once: true })
      list.push(waiter)
      this.emit('change')
    })
  }

  wakeNext(envId) {
    const list = this.waiters.get(envId)
    const def = this.get(envId)
    if (!list || list.length === 0 || !def) return
    if (this.status(def).busy) return
    list[0].wake()
  }

  onLeaseReleased(lease) {
    this.emit('change')
    this.wakeNext(lease.envId)
  }

  async releaseAll(predicate = () => true) {
    await Promise.all([...this.leases.values()].filter(predicate).map(l => l.release('released')))
  }

  // ---------------------------------------------------------------- session / workspace settings

  normPath(p) {
    if (!p) return p
    const r = path.resolve(p)
    return process.platform === 'win32' ? r.toLowerCase() : r
  }

  workspaceSettings(hostPath) {
    return this.state.workspaces[this.normPath(hostPath)] ?? {}
  }

  setWorkspaceSettings(hostPath, patch) {
    const key = this.normPath(hostPath)
    this.state.workspaces[key] = { ...this.state.workspaces[key], ...patch }
    this.save()
    return this.state.workspaces[key]
  }

  sessionSettings(sessionId) {
    return this.state.sessions[sessionId] ?? {}
  }

  setSessionSettings(sessionId, patch) {
    const next = { ...this.state.sessions[sessionId], ...patch, updatedAt: Date.now() }
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null) delete next[k]
    this.state.sessions[sessionId] = next
    this.save()
    return next
  }

  /** Remote workspace whose host placeholder contains (or equals) the given host directory. */
  remoteWorkspaceFor(hostPath) {
    if (!hostPath) return undefined
    const p = this.normPath(hostPath)
    return this.state.remoteWorkspaces.find(w => {
      const h = this.normPath(w.hostPath)
      return p === h || p.startsWith(h + path.sep)
    })
  }

  /** Mount effective for a session: explicit session choice, else its remote workspace. */
  mountFor(sessionId, cwd) {
    const s = this.sessionSettings(sessionId)
    if (s.mount === false) return undefined
    if (s.mount?.envId) return { ...s.mount, hostRoot: s.mount.hostRoot ?? cwd, source: 'session' }
    const ws = this.remoteWorkspaceFor(cwd)
    if (ws) return { envId: ws.envId, remoteRoot: ws.root, hostRoot: ws.hostPath, source: 'workspace', workspace: ws.id }
    return undefined
  }

  /** Environments a session may borrow: session list, else workspace list, else every borrowable env. */
  borrowableFor(sessionId, cwd) {
    const s = this.sessionSettings(sessionId)
    let ids = s.borrowable
    let source = 'session'
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

  addRemoteWorkspace({ envId, root, title, mountsDir }) {
    const def = this.require(envId)
    const id = crypto.randomUUID().slice(0, 8)
    const name = `${slug(def.id)}-${slug(path.posix.basename(root.replace(/\\/g, '/')) || 'root')}-${id}`
    const hostPath = path.join(mountsDir, name)
    fs.mkdirSync(hostPath, { recursive: true })
    fs.writeFileSync(path.join(hostPath, '.dsh-environment-mount.json'), JSON.stringify({ envId, root, note: 'Placeholder for a remote workspace mounted by dsh-plugin-environments. Files live in the environment.' }, null, 2))
    const ws = { id, envId, root, title: title || `${path.posix.basename(root.replace(/\\/g, '/')) || root} @ ${def.name}`, hostPath, createdAt: Date.now() }
    this.state.remoteWorkspaces.push(ws)
    this.save()
    return ws
  }

  removeRemoteWorkspace(id) {
    const ws = this.state.remoteWorkspaces.find(w => w.id === id)
    this.state.remoteWorkspaces = this.state.remoteWorkspaces.filter(w => w.id !== id)
    this.save()
    return ws
  }

  async dispose() {
    this.disposed = true
    this.flush()
    for (const list of this.waiters.values()) for (const w of [...list]) w.wake?.()
    await this.releaseAll()
    for (const entry of this.browseConnections.values()) {
      clearTimeout(entry.timer)
      entry.promise.then(env => env.close(), () => {})
    }
    this.browseConnections.clear()
  }
}
