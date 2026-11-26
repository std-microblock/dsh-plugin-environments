// Borrowing state of one MCP connection: the environments it holds, the resolution of the
// `environment` argument, the workspace side of transfers, and the image results.
//
// It mirrors what the DSH plugin's borrowing module does for a session, without mounts, session
// settings or prompt sections: an MCP client borrows an environment, uses the env_* tools with
// the returned alias, and returns it. A lease whose connection drops keeps reconnecting by itself,
// like a DSH session's.
import crypto from 'node:crypto'
import { EnvError, errorMessage } from '@dsh-environments/protocol'
import type { Environment } from '../env/environment.ts'
import { HostEnvironment } from '../env/host-env.ts'
import type { Agent, PluginContext } from '../host-api.ts'
import { aliasFor, definitionLabel, type EnvironmentDefinition } from '../manager/definitions.ts'
import type { Lease } from '../manager/lease.ts'
import type { EnvironmentManager } from '../manager/manager.ts'
import { copyBetween, formatSize } from '../tools/common.ts'
import type { LeaseTarget, ToolRequirement, WorkspaceLocation } from '../tools/lease/context.ts'
import type { ManagedProcess } from '../tools/lease/process-tools.ts'
import { ScreenSession } from '../tools/screen/session.ts'
import { MemoryAttachments } from './attachments.ts'

/** One environment held by this MCP connection. */
export interface McpEntry {
  readonly lease: Lease
  readonly alias: string
  /** The entry holds the lease's GUI (screen tools act on it). */
  gui: boolean
  readonly processes: Map<string, ManagedProcess>
  readonly screens: WeakMap<Environment, ScreenSession>
  seq: number
  dropped: boolean
}

/** What a tool execution looks like to the shared tool bodies (`exec.agent` / `exec.signal`). */
export interface McpExec {
  agent?: unknown
  signal?: AbortSignal | undefined
}

export interface WaitOptions {
  wait: boolean
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}

export interface BorrowOptions extends WaitOptions {
  gui: boolean
  reason?: string | undefined
}

/** A resolved transfer endpoint. */
interface Location extends WorkspaceLocation {
  path: string
  label: string
}

export interface McpSessionOptions {
  manager: EnvironmentManager
  /** Directory plain (alias-less) transfer paths are relative to. */
  workspaceDir: string
  /** Client name from `initialize`, shown to a human in the DSH lease list. */
  clientName?: string | undefined
  /** Environment ids this connection may borrow (default: every borrowable environment). */
  allow?: readonly string[] | undefined
  log?: ((message: string) => void) | undefined
}

/** The environment ids of a property-free set, or undefined for "everything". */
function allowSet(ids: readonly string[] | undefined): ReadonlySet<string> | undefined {
  return ids && ids.length > 0 ? new Set(ids) : undefined
}

export class McpSession {
  readonly manager: EnvironmentManager
  readonly workspaceDir: string
  readonly sessionId = `mcp-${crypto.randomUUID().slice(0, 8)}`
  /** Name shown to a human in the DSH lease list (`MCP: <client> (pid 1234)`). */
  title: string
  readonly attachments = new MemoryAttachments()
  readonly entries = new Map<string, McpEntry>()
  readonly ctx: PluginContext
  readonly agent: Agent
  private readonly allow: ReadonlySet<string> | undefined
  private readonly log: (message: string) => void
  private procSeq = 0
  private disposed = false

  constructor({ manager, workspaceDir, clientName, allow, log }: McpSessionOptions) {
    this.manager = manager
    this.workspaceDir = workspaceDir
    this.allow = allowSet(allow)
    this.log = log ?? (() => {})
    this.title = `MCP: ${clientName?.trim() || 'client'} (pid ${process.pid})`
    // The shared tool bodies only reach into the context for image attachments.
    this.ctx = {
      get: (name: string) => (name === 'attachments' ? this.attachments : undefined),
    } as unknown as PluginContext
    this.agent = {
      ctx: this.ctx,
      session: { id: this.sessionId, header: { id: this.sessionId, cwd: workspaceDir } },
    }
  }

  /** Adopt the name the client reported in `initialize` (leases taken before keep the old title). */
  setClientName(name: string | undefined): void {
    const trimmed = name?.trim()
    if (!trimmed) return
    this.title = `MCP: ${trimmed} (pid ${process.pid})`
  }

  /** The execution handle the tool bodies expect. */
  exec(signal?: AbortSignal): McpExec {
    return { agent: this.agent, signal }
  }

  /** Environments this connection may borrow. */
  borrowable(): EnvironmentDefinition[] {
    return this.manager.definitions().filter(d => d.borrowable !== false && (!this.allow || this.allow.has(d.id)))
  }

  /** The held entry an alias (or environment id / name) refers to. */
  find(name: string): McpEntry | undefined {
    const direct = this.entries.get(name)
    if (direct) return direct
    for (const entry of this.entries.values()) {
      if (entry.lease.envId === name || matches(entry.lease.def, name)) return entry
    }
    return undefined
  }

  private freeAlias(base: string): string {
    let alias = base
    for (let i = 2; this.entries.has(alias); i++) alias = `${base}_${i}`
    return alias
  }

  /** Whether this connection may borrow the definition; throws EPERM otherwise. */
  private checkAllowed(def: EnvironmentDefinition): void {
    if (def.borrowable === false) throw new EnvError('EPERM', `${def.name} is not borrowable`)
    if (this.allow && !this.allow.has(def.id))
      throw new EnvError(
        'EPERM',
        `${def.name} is not in this MCP server's allow-list (allowed: ${[...this.allow].join(', ')})`,
      )
  }

  /** Create the entry of a freshly acquired lease. */
  private attach(lease: Lease, gui: boolean): McpEntry {
    const entry: McpEntry = {
      lease,
      alias: this.freeAlias(aliasFor(lease.envId)),
      gui,
      processes: new Map(),
      screens: new WeakMap(),
      seq: 0,
      dropped: false,
    }
    this.entries.set(entry.alias, entry)
    lease.once('release', why => {
      this.log(`lease of ${lease.def.name} released (${why})`)
      void this.drop(entry)
    })
    return entry
  }

  /** Forget an entry whose lease ended elsewhere; processes stop with the connection. */
  private async drop(entry: McpEntry): Promise<void> {
    if (entry.dropped) return
    entry.dropped = true
    if (this.entries.get(entry.alias) === entry) this.entries.delete(entry.alias)
    entry.processes.clear()
  }

  /** Take or give up the GUI of a held entry. */
  async setGui(entry: McpEntry, on: boolean, opts: WaitOptions): Promise<void> {
    if (on === entry.gui) return
    if (!on) {
      entry.gui = false
      await this.manager.setGui(entry.lease, this.sessionId, false)
      return
    }
    await this.manager.setGui(entry.lease, this.sessionId, true, {
      wait: opts.wait,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    })
    entry.gui = true
  }

  /** Borrow an environment, or change the mode of one already held. */
  async borrow(envId: string, { gui, wait, timeoutMs, signal, reason }: BorrowOptions): Promise<McpEntry> {
    const def = await this.manager.resolve(envId)
    this.checkAllowed(def)
    const existing = this.entries.get(aliasFor(def.id)) ?? this.find(def.id)
    if (existing && !existing.dropped) {
      await this.setGui(existing, gui, { wait, timeoutMs, signal })
      return existing
    }
    const lease = await this.manager.acquire(def.id, {
      owner: { sessionId: this.sessionId, title: this.title, reason },
      purpose: 'borrow',
      mode: gui ? 'gui' : 'headless',
      wait,
      timeoutMs,
      signal,
    })
    return this.attach(lease, gui)
  }

  /** Return one entry, or every entry ("all"). `guiOnly` gives back only the GUI. */
  async release(name: string, guiOnly: boolean): Promise<string[]> {
    const targets = name === 'all' ? [...this.entries.values()] : [this.find(name)].filter(isEntry)
    if (targets.length === 0)
      throw new EnvError(
        'ENOENT',
        `nothing borrowed as "${name}" (borrowed: ${[...this.entries.keys()].join(', ') || 'none'})`,
      )
    const out: string[] = []
    for (const entry of targets) {
      if (guiOnly) {
        if (!entry.gui) {
          out.push(`${entry.lease.def.name} holds no GUI`)
          continue
        }
        await this.setGui(entry, false, { wait: false })
        out.push(`gave back the GUI of ${entry.lease.def.name} ("${entry.alias}" stays borrowed headless)`)
        continue
      }
      await this.killProcesses(entry)
      await this.manager.setGui(entry.lease, this.sessionId, false).catch(() => {})
      await this.drop(entry)
      await entry.lease.release('returned')
      out.push(`returned ${entry.lease.def.name}`)
    }
    return out
  }

  private async killProcesses(entry: McpEntry): Promise<void> {
    for (const mp of entry.processes.values()) if (!mp.exit) await mp.proc.kill().catch(() => {})
    entry.processes.clear()
  }

  /** Resolve the `environment` argument of a tool call into the entry it acts on. */
  async resolve(exec: McpExec, environment: string | undefined, req: ToolRequirement): Promise<LeaseTarget> {
    const entries = [...this.entries.values()].filter(e => !e.dropped)
    const offers = (e: McpEntry) => req.supports?.(e.lease.env) ?? true
    const usable = (e: McpEntry) => (req.gui ? e.gui : true) && offers(e)
    const heldText = () => entries.map(e => `${e.alias} (${e.gui ? 'GUI' : 'headless'})`).join(', ') || 'none'
    const toolName = (r: ToolRequirement) => `env_${r.name}`
    let entry: McpEntry | undefined
    if (environment) {
      entry = this.find(environment)
      if (!entry || entry.dropped)
        throw new EnvError(
          'ENOENT',
          `"${environment}" is not borrowed by this connection (borrowed: ${heldText()}); borrow it with env_borrow first`,
        )
      if (req.gui && !entry.gui)
        throw new EnvError(
          'EINVAL',
          `${entry.alias} is borrowed headless; env_borrow { environment: "${entry.lease.envId}", gui: true } takes its GUI`,
        )
      if (!offers(entry))
        throw new EnvError(
          'UNSUPPORTED',
          `${toolName(req)} is not available on ${entry.lease.def.name} (${entry.lease.def.kind})`,
        )
    } else {
      const candidates = entries.filter(usable)
      if (candidates.length > 1)
        throw new EnvError(
          'EINVAL',
          `several borrowed environments offer ${toolName(req)} (${candidates.map(e => e.alias).join(', ')}); pass environment`,
        )
      entry = candidates[0]
      if (!entry)
        throw new EnvError(
          'ENOENT',
          entries.length === 0
            ? 'nothing is borrowed yet; call env_borrow first'
            : req.gui
              ? `no borrowed environment holds a GUI that offers ${toolName(req)} (borrowed: ${heldText()}); env_borrow with gui: true takes one`
              : `none of the borrowed environments offers ${toolName(req)} (borrowed: ${heldText()})`,
        )
    }
    const env = await entry.lease.ready({ signal: exec.signal })
    if (entry.dropped) throw new EnvError('ECLOSED', `${entry.alias} was returned meanwhile`)
    return this.targetOf(entry, env)
  }

  private targetOf(entry: McpEntry, env: Environment): LeaseTarget {
    let screen = entry.screens.get(env)
    if (!screen) {
      screen = new ScreenSession(env)
      entry.screens.set(env, screen)
    }
    const cwd = env.info?.cwd
    return {
      lease: entry.lease,
      env,
      alias: entry.alias,
      label: `${entry.lease.def.name} (${entry.alias})`,
      cwd,
      abs: p => env.resolvePath(p ?? '.', cwd),
      screen,
      processes: entry.processes,
      nextProcessId: () => `p${++entry.seq}`,
    }
  }

  /** The workspace side of a transfer: the MCP server's workspace directory. */
  async workspaceOf(exec: McpExec, sourceAlias?: string, filePath?: string): Promise<WorkspaceLocation> {
    if (sourceAlias && sourceAlias !== 'workspace') {
      const entry = this.find(sourceAlias)
      if (!entry || entry.dropped) throw new EnvError('ENOENT', `no borrowed environment with alias "${sourceAlias}"`)
      const env = await entry.lease.ready({ signal: exec.signal })
      return { env, cwd: env.info?.cwd }
    }
    const host = new HostEnvironment(this.workspaceDir)
    return {
      env: host,
      cwd: this.workspaceDir,
      hostPath: filePath ? host.resolvePath(filePath, this.workspaceDir) : undefined,
    }
  }

  /** Parse "alias:path" (an alias, or "workspace") resp. a plain workspace path. */
  async location(exec: McpExec, spec: string): Promise<Location> {
    const m = /^([A-Za-z][A-Za-z0-9_]*):(.*)$/.exec(spec)
    const alias = m?.[1]
    // A single letter is a Windows drive, not an alias.
    if (m && alias && !/^[A-Za-z]$/.test(alias)) {
      const rest = m[2] || '.'
      const w = await this.workspaceOf(exec, alias)
      return { ...w, path: w.env.resolvePath(rest, w.cwd), label: alias }
    }
    const w = await this.workspaceOf(exec)
    return { ...w, path: w.env.resolvePath(spec, w.cwd), label: 'workspace' }
  }

  /** Copy a file or directory between the workspace and borrowed environments. */
  async transfer(
    spec: { source: string; destination: string; overwrite?: boolean | undefined },
    signal?: AbortSignal,
  ): Promise<string> {
    const exec = this.exec(signal)
    const src = await this.location(exec, spec.source)
    const dst = await this.location(exec, spec.destination)
    const srcStat = await src.env.stat(src.path)
    if (!srcStat) throw new EnvError('ENOENT', `source not found: ${spec.source}`)
    const dstStat = await dst.env.stat(dst.path).catch(() => null)
    let target = dst.path
    if (dstStat?.type === 'dir' && srcStat.type === 'file')
      target = dst.env.path.join(target, src.env.path.basename(src.path))
    const started = Date.now()
    const r = await copyBetween(src.env, src.path, dst.env, target, { overwrite: !!spec.overwrite, signal })
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    return `Copied ${r.files} file${r.files === 1 ? '' : 's'} (${formatSize(r.bytes)}) from ${src.label}:${src.path} to ${dst.label}:${target} in ${secs}s.`
  }

  /** `env_list` text: the environments this connection may borrow, their live status, and what it holds. */
  async listText(): Promise<string> {
    await this.manager.refreshDiscovery()
    const mine = [...this.entries.values()].filter(e => !e.dropped)
    const lines = this.borrowable().map(d => {
      const st = this.manager.status(d)
      const holding = mine.find(e => e.lease.envId === d.id)
      const who = (h: { title?: string | undefined; sessionId?: string | undefined }) => h.title ?? h.sessionId
      const parts: string[] = []
      if (holding) parts.push(`held by you as "${holding.alias}" (${holding.gui ? 'GUI' : 'headless'})`)
      else if (st.busy)
        parts.push(
          `busy (exclusive; ${st.holders.map(who).join(', ')}${st.queue.length ? `; ${st.queue.length} waiting` : ''})`,
        )
      else parts.push(st.holders.length ? `available headless (${st.holders.length} in use)` : 'available')
      const lease = holding?.lease
      if (lease?.connection === 'reconnecting')
        parts.push(`connection lost, reconnecting (${lease.connectionError ?? 'connection lost'})`)
      if (st.gui && !holding?.gui) parts.push(`GUI held by ${st.gui.title ?? st.gui.sessionId ?? 'another session'}`)
      const guiQueue = st.queue.filter(q => q.mode === 'gui').length
      if (guiQueue && !st.busy) parts.push(`${guiQueue} waiting for the GUI`)
      if (!st.headlessParallel && !st.busy && !holding) parts.push('exclusive')
      return `- ${definitionLabel(d)} — ${parts.join('; ')}`
    })
    return [
      `Borrowable environments (${this.allow ? 'allow-list' : 'all configured'}):`,
      lines.join('\n') || '(none — configure environments in DeepSeek Harness first)',
      mine.length
        ? `\nBorrowed now: ${mine.map(e => `${e.alias} → ${e.lease.def.name} (${e.gui ? 'GUI' : 'headless'})`).join(', ')}`
        : '',
      `\nWorkspace for transfers: ${this.workspaceDir}`,
    ]
      .filter(Boolean)
      .join('\n')
  }

  /** Release everything this connection held and stop the manager's connections. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const entry of [...this.entries.values()]) {
      await this.killProcesses(entry).catch(() => {})
      await entry.lease.release('MCP connection closed').catch(() => {})
    }
    this.entries.clear()
    await this.manager.dispose().catch((e: unknown) => this.log(`dispose: ${errorMessage(e)}`))
  }
}

function isEntry(value: McpEntry | undefined): value is McpEntry {
  return value !== undefined
}

/** Whether a definition is the one a name refers to. */
function matches(d: EnvironmentDefinition, name: string): boolean {
  return d.id === name || d.name === name || aliasFor(d.id) === name
}
