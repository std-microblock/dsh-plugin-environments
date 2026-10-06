// Cheap availability checks of environments for the GUI (red dot on unavailable workspace bindings).
// Nothing here opens a full environment connection: a check is a TCP reachability probe, an
// `adb devices` lookup, or the state of a connection that is already open.
import net from 'node:net'
import { errorMessage } from '@dsh-environments/protocol'
import { listAdbDevices, type AdbDevice } from '../env/adb/devices.ts'
import type { EnvironmentDefinition } from './definitions.ts'
import type { EnvironmentManager } from './manager.ts'

/**
 * - `available`: reachable (or connected right now);
 * - `busy`: reachable, but an exclusive environment held by a lease;
 * - `offline`: the device or host cannot be reached (adb device absent, port closed, timeout);
 * - `error`: the check itself failed or the definition is gone;
 * - `unknown`: no cheap check exists for the kind, or the first check is still running.
 */
export type AvailabilityState = 'available' | 'busy' | 'offline' | 'error' | 'unknown'

export interface Availability {
  state: AvailabilityState
  reason?: string | undefined
  checkedAt: number
}

/** States the GUI marks with a red dot. */
export function isUnavailable(state: AvailabilityState): boolean {
  return state === 'offline' || state === 'error'
}

export type TcpProbe = (host: string, port: number, timeoutMs: number) => Promise<void>
export type AdbLister = (adb: string) => Promise<AdbDevice[]>

export interface AvailabilityOptions {
  /** How long a result is reused (default 15 s). */
  ttlMs?: number
  /** Timeout of one TCP probe (default 3 s). */
  probeTimeoutMs?: number
  tcpProbe?: TcpProbe
  listAdb?: AdbLister
  platform?: NodeJS.Platform
  now?: () => number
}

/** Open and immediately close a TCP connection. */
export const tcpProbe: TcpProbe = (host, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    const done = (error?: Error) => {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => done(new Error(`timed out connecting to ${host}:${port}`)), timeoutMs)
    socket.once('connect', () => done())
    socket.once('error', e => done(e))
  })

interface CacheEntry {
  value?: Availability
  pending?: Promise<Availability>
}

export class AvailabilityChecker {
  readonly manager: EnvironmentManager
  private readonly ttlMs: number
  private readonly probeTimeoutMs: number
  private readonly tcp: TcpProbe
  private readonly listAdb: AdbLister
  private readonly platform: NodeJS.Platform
  private readonly now: () => number
  private readonly cache = new Map<string, CacheEntry>()
  private readonly adbCache = new Map<string, { at: number; devices: Promise<AdbDevice[]> }>()

  constructor(manager: EnvironmentManager, options: AvailabilityOptions = {}) {
    this.manager = manager
    this.ttlMs = options.ttlMs ?? 15000
    this.probeTimeoutMs = options.probeTimeoutMs ?? 3000
    this.tcp = options.tcpProbe ?? tcpProbe
    this.listAdb = options.listAdb ?? (adb => listAdbDevices(adb))
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? Date.now
  }

  /** Forget cached results (all, or of one environment after it was edited). */
  invalidate(envId?: string): void {
    if (envId === undefined) this.cache.clear()
    else this.cache.delete(envId)
  }

  /**
   * Availability of several environments. Checks that do not finish within `waitMs` report their
   * previous result (or `unknown`) and keep running, so the next call picks them up.
   */
  async check(envIds: Iterable<string>, { waitMs = 2000 }: { waitMs?: number } = {}): Promise<Record<string, Availability>> {
    const ids = [...new Set(envIds)]
    const out: Record<string, Availability> = {}
    await Promise.all(
      ids.map(async id => {
        out[id] = await this.one(id, waitMs)
      }),
    )
    return out
  }

  private async one(envId: string, waitMs: number): Promise<Availability> {
    const def = this.manager.get(envId)
    if (!def) return { state: 'error', reason: `unknown environment "${envId}"`, checkedAt: this.now() }
    // An open lease is the best evidence: the environment is connected right now.
    const live = this.manager.leasesOf(def.id).filter(l => !l.released && !l.env.closed)
    if (live.length > 0) {
      const busy = this.manager.status(def).busy
      return { state: busy ? 'busy' : 'available', reason: busy ? 'in use' : 'connected', checkedAt: this.now() }
    }
    const entry = this.cache.get(envId) ?? {}
    this.cache.set(envId, entry)
    if (entry.value && this.now() - entry.value.checkedAt < this.ttlMs) return entry.value
    if (!entry.pending) {
      const pending = this.probe(def).then(
        value => value,
        (e: unknown): Availability => ({ state: 'error', reason: errorMessage(e), checkedAt: this.now() }),
      )
      entry.pending = pending
      void pending.then(value => {
        entry.value = value
        if (entry.pending === pending) delete entry.pending
      })
    }
    const pending = entry.pending
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), waitMs)
      timer.unref?.()
    })
    const value = await Promise.race([pending, late])
    clearTimeout(timer)
    return value ?? entry.value ?? { state: 'unknown', reason: 'checking', checkedAt: this.now() }
  }

  private async probe(def: EnvironmentDefinition): Promise<Availability> {
    const c = def.config
    const at = () => this.now()
    switch (def.kind) {
      case 'local':
        return { state: 'available', checkedAt: at() }
      case 'server':
      case 'ssh': {
        const host = c.host ?? ''
        const port = Number(c.port ?? (def.kind === 'ssh' ? 22 : NaN))
        if (!host || !Number.isFinite(port)) return { state: 'error', reason: 'host or port missing', checkedAt: at() }
        try {
          await this.tcp(host, port, this.probeTimeoutMs)
          return { state: 'available', checkedAt: at() }
        } catch (e) {
          return { state: 'offline', reason: `${host}:${port} unreachable (${errorMessage(e)})`, checkedAt: at() }
        }
      }
      case 'adb': {
        let devices: AdbDevice[]
        try {
          devices = await this.adbDevices(c.adb || this.manager.adb)
        } catch (e) {
          return { state: 'error', reason: `adb: ${errorMessage(e)}`, checkedAt: at() }
        }
        const device = devices.find(d => d.serial === c.serial)
        if (!device) return { state: 'offline', reason: `device ${c.serial ?? '?'} not connected`, checkedAt: at() }
        if (device.state !== 'device') {
          return { state: 'offline', reason: `device ${device.serial} is ${device.state}`, checkedAt: at() }
        }
        return { state: 'available', checkedAt: at() }
      }
      case 'winuser':
        return this.platform === 'win32'
          ? { state: 'available', checkedAt: at() }
          : { state: 'error', reason: 'Windows accounts need a Windows host', checkedAt: at() }
      default:
        return { state: 'unknown', checkedAt: at() }
    }
  }

  private adbDevices(adb: string): Promise<AdbDevice[]> {
    // Reuse the manager's discovery when it ran recently with the same adb.
    const d = this.manager.discovered
    if (adb === this.manager.adb && this.manager.autoDiscoverAdb && this.now() - d.at < 5000 && !d.adbError) {
      return Promise.resolve(d.adb)
    }
    const hit = this.adbCache.get(adb)
    if (hit && this.now() - hit.at < 5000) return hit.devices
    const devices = this.listAdb(adb)
    this.adbCache.set(adb, { at: this.now(), devices })
    devices.catch(() => this.adbCache.delete(adb))
    return devices
  }
}
