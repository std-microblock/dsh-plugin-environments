// One borrow (or mount) of an environment.
import { EventEmitter } from 'node:events'
import { EnvError, errorMessage } from '@dsh-environments/protocol'
import type { Environment } from '../env/environment.ts'
import type { TunnelInfo } from '../env/types.ts'
import type { EnvironmentDefinition, LeaseMode } from './definitions.ts'

export interface LeaseOwner {
  sessionId?: string | undefined
  title?: string | undefined
  reason?: string | undefined
}

export type LeasePurpose = 'borrow' | 'mount' | (string & {})

export interface LeaseEvents {
  release: [string]
  /** The lease switched between headless and GUI. */
  mode: [LeaseMode]
  /** The connection was lost; the lease keeps its place and reconnects (`reason`). */
  disconnect: [string]
  /** A new connection replaced the lost one (`env` is the new one, `previous` the lost one). */
  reconnect: [Environment, Environment]
}

/** Whether the lease's connection is up, or lost and being re-established. */
export type LeaseConnection = 'connected' | 'reconnecting'

export interface LeaseDescription {
  id: string
  envId: string
  alias: string
  purpose: LeasePurpose
  owner: LeaseOwner | undefined
  createdAt: number
  tunnels: TunnelInfo[]
  mode: LeaseMode
  /** Sessions using the lease's GUI (the owner, or subagents sharing its mount). */
  guiUsers: string[]
  connection: LeaseConnection
  /** When the connection was lost (while reconnecting). */
  disconnectedAt?: number | undefined
  /** Why the connection was lost, or why the latest reconnect attempt failed. */
  connectionError?: string | undefined
}

/** What a lease needs from its manager. */
export interface LeaseRegistry {
  forgetLease(lease: Lease): void
  onLeaseReleased(lease: Lease): void
  onLeaseModeChanged(lease: Lease): void
  onLeaseConnectionChanged?(lease: Lease): void
}

/** Opens a fresh connection for a lease whose connection was lost. */
export type LeaseReopener = (signal: AbortSignal) => Promise<Environment>

export interface LeaseOptions {
  id: string
  def: EnvironmentDefinition
  env: Environment
  owner: LeaseOwner | undefined
  purpose: LeasePurpose
  alias: string
  /** Reconnect after a lost connection instead of releasing the lease. */
  reopen?: LeaseReopener | undefined
}

export interface ReadyOptions {
  /** How long to wait for a lost connection to come back (default 20 s). */
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}

/** Delay before the n-th background reconnect attempt (n ≥ 1): 1 s, 2 s, 4 s … 30 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, Math.min(5, attempt - 1)))
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>(resolve => {
    const t = setTimeout(done, ms)
    t.unref?.()
    function done() {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })

/**
 * One borrow (or mount) of an environment. The holder owns an independent connection;
 * releasing closes it together with every tunnel and process opened through it.
 *
 * A lost connection does not end the lease when it can reopen one: the lease stays held (in its
 * mode, with its GUI) and reconnects in the background, with growing delays. `env` is then
 * replaced by the new connection, so holders read `lease.env` (or await `ready()`) at each use
 * instead of keeping the environment. Processes and tunnels of the lost connection are gone.
 *
 * A lease is headless or GUI. It is a GUI lease while at least one session uses its GUI
 * (`guiUsers`); only the manager adds users (`EnvironmentManager.setGui`), because taking the
 * GUI is subject to the environment's admission rules.
 */
export class Lease extends EventEmitter<LeaseEvents> {
  readonly registry: LeaseRegistry
  readonly id: string
  readonly def: EnvironmentDefinition
  /** The current connection (replaced after a reconnect). */
  env: Environment
  readonly owner: LeaseOwner | undefined
  readonly purpose: LeasePurpose
  readonly alias: string
  readonly createdAt = Date.now()
  /** Session ids using the GUI of this lease. */
  readonly guiUsers = new Set<string>()
  released = false
  connection: LeaseConnection = 'connected'
  disconnectedAt: number | undefined = undefined
  connectionError: string | undefined = undefined
  private readonly reopen: LeaseReopener | undefined
  private failures = 0
  private retryTimer: NodeJS.Timeout | undefined
  private attempt: Promise<void> | undefined
  private attemptAbort: AbortController | undefined

  constructor(registry: LeaseRegistry, { id, def, env, owner, purpose, alias, reopen }: LeaseOptions) {
    super()
    this.registry = registry
    this.id = id
    this.def = def
    this.env = env
    this.owner = owner
    this.purpose = purpose
    this.alias = alias
    this.reopen = reopen
    this.watch(env)
  }

  get envId(): string {
    return this.def.id
  }

  get mode(): LeaseMode {
    return this.guiUsers.size > 0 ? 'gui' : 'headless'
  }

  private watch(env: Environment): void {
    env.once('close', error => this.lost(env, error))
  }

  private lost(env: Environment, error: Error | undefined): void {
    if (this.released || env !== this.env) return
    if (!this.reopen) {
      void this.release('connection lost')
      return
    }
    this.connection = 'reconnecting'
    this.disconnectedAt = Date.now()
    this.connectionError = error ? errorMessage(error) : 'connection lost'
    this.failures = 0
    this.emit('disconnect', this.connectionError)
    this.registry.onLeaseConnectionChanged?.(this)
    this.schedule(0)
  }

  private schedule(ms: number): void {
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => void this.reconnect(), ms)
    this.retryTimer.unref?.()
  }

  /** One reconnect attempt (shared by concurrent callers); schedules the next one on failure. */
  private reconnect(): Promise<void> {
    const reopen = this.reopen
    if (this.released || this.connection === 'connected' || !reopen) return Promise.resolve()
    this.attempt ??= (async () => {
      const abort = new AbortController()
      this.attemptAbort = abort
      try {
        const env = await reopen(abort.signal)
        if (this.released) {
          await env.close().catch(() => {})
          return
        }
        const previous = this.env
        this.env = env
        this.connection = 'connected'
        this.disconnectedAt = undefined
        this.connectionError = undefined
        this.failures = 0
        clearTimeout(this.retryTimer)
        this.watch(env)
        this.emit('reconnect', env, previous)
        this.registry.onLeaseConnectionChanged?.(this)
      } catch (e) {
        if (this.released) return
        this.failures++
        this.connectionError = errorMessage(e)
        this.schedule(reconnectDelay(this.failures))
        this.registry.onLeaseConnectionChanged?.(this)
      } finally {
        this.attempt = undefined
        this.attemptAbort = undefined
      }
    })()
    return this.attempt
  }

  /** Held, but without a connection right now. */
  private down(): boolean {
    return !this.released && this.connection === 'reconnecting'
  }

  /**
   * The current connection, waiting up to `timeoutMs` (retrying right away) while it is being
   * re-established. Throws ECLOSED for a released lease and EDISCONNECTED when it stays down.
   */
  async ready({ timeoutMs = 20_000, signal }: ReadyOptions = {}): Promise<Environment> {
    const deadline = Date.now() + timeoutMs
    while (!this.released && this.connection === 'reconnecting') {
      signal?.throwIfAborted()
      const left = deadline - Date.now()
      if (left <= 0) break
      const tried = this.reconnect()
      await Promise.race([tried, sleep(left, signal)])
      if (!this.down()) break
      await sleep(Math.min(1000, Math.max(0, deadline - Date.now())), signal)
    }
    signal?.throwIfAborted()
    if (this.released) throw new EnvError('ECLOSED', `the lease of ${this.def.name} was released`)
    if (this.connection === 'reconnecting') {
      throw new EnvError(
        'EDISCONNECTED',
        `${this.def.name} lost its connection (${this.connectionError ?? 'connection lost'}) and has not reconnected yet; it keeps retrying in the background and stays borrowed`,
      )
    }
    return this.env
  }

  /** Add or remove a GUI user (manager only: admission is checked there). */
  setGuiUser(user: string, on: boolean): void {
    const before = this.mode
    if (on) this.guiUsers.add(user)
    else this.guiUsers.delete(user)
    if (this.mode !== before) {
      this.emit('mode', this.mode)
      this.registry.onLeaseModeChanged(this)
    }
  }

  async release(reason = 'returned'): Promise<void> {
    if (this.released) return
    this.released = true
    clearTimeout(this.retryTimer)
    this.attemptAbort?.abort()
    this.registry.forgetLease(this)
    this.emit('release', reason)
    try {
      await this.env.close()
    } catch {
      // closing a broken connection
    }
    this.registry.onLeaseReleased(this)
  }

  describe(): LeaseDescription {
    return {
      id: this.id,
      envId: this.envId,
      alias: this.alias,
      purpose: this.purpose,
      owner: this.owner,
      createdAt: this.createdAt,
      tunnels: this.env.listTunnels(),
      mode: this.mode,
      guiUsers: [...this.guiUsers],
      connection: this.connection,
      disconnectedAt: this.disconnectedAt,
      connectionError: this.connectionError,
    }
  }
}
