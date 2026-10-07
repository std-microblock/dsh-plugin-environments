// One borrow (or mount) of an environment.
import { EventEmitter } from 'node:events'
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
}

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
}

/** What a lease needs from its manager. */
export interface LeaseRegistry {
  forgetLease(lease: Lease): void
  onLeaseReleased(lease: Lease): void
  onLeaseModeChanged(lease: Lease): void
}

export interface LeaseOptions {
  id: string
  def: EnvironmentDefinition
  env: Environment
  owner: LeaseOwner | undefined
  purpose: LeasePurpose
  alias: string
}

/**
 * One borrow (or mount) of an environment. The holder owns an independent connection;
 * releasing closes it together with every tunnel and process opened through it.
 *
 * A lease is headless or GUI. It is a GUI lease while at least one session uses its GUI
 * (`guiUsers`); only the manager adds users (`EnvironmentManager.setGui`), because taking the
 * GUI is subject to the environment's admission rules.
 */
export class Lease extends EventEmitter<LeaseEvents> {
  readonly registry: LeaseRegistry
  readonly id: string
  readonly def: EnvironmentDefinition
  readonly env: Environment
  readonly owner: LeaseOwner | undefined
  readonly purpose: LeasePurpose
  readonly alias: string
  readonly createdAt = Date.now()
  /** Session ids using the GUI of this lease. */
  readonly guiUsers = new Set<string>()
  released = false

  constructor(registry: LeaseRegistry, { id, def, env, owner, purpose, alias }: LeaseOptions) {
    super()
    this.registry = registry
    this.id = id
    this.def = def
    this.env = env
    this.owner = owner
    this.purpose = purpose
    this.alias = alias
    env.once('close', () => void this.release('connection lost'))
  }

  get envId(): string {
    return this.def.id
  }

  get mode(): LeaseMode {
    return this.guiUsers.size > 0 ? 'gui' : 'headless'
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
    }
  }
}
