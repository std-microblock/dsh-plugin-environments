// Borrowing: env_list / env_borrow / env_return / env_transfer plus per-lease tool sets.
//
// Every lease is headless or GUI (see `manager.ts` for the admission rules). A session holds an
// environment through one entry per environment:
//
// - a borrowed entry owns its lease: the headless tools always, the GUI tools while it holds the
//   GUI (`env_borrow` with `gui: true`, again on a held environment to upgrade; `env_return` with
//   `gui_only: true`, or `env_borrow` with `gui: false`, to downgrade);
// - a mount entry is attached to the session's mount lease and exists only while the session
//   holds that lease's GUI. Its tools are the GUI set (the mount covers files and the shell);
//   returning it gives up the GUI and keeps the mount.
import { errorMessage } from '@dsh-environments/protocol'
import type { EventEmitter } from 'node:events'
import type { HarnessDeps, HarnessScope } from '../deps.ts'
import type { Environment } from '../env/environment.ts'
import { HostEnvironment } from '../env/host-env.ts'
import { agentOf, sessionIdOf, type Agent, type PluginContext } from '../host-api.ts'
import { aliasFor, type EnvironmentDefinition } from '../manager/definitions.ts'
import type { Lease } from '../manager/lease.ts'
import type { EnvironmentManager } from '../manager/manager.ts'
import type { MountingEvents, MountRecord } from '../mount/index.ts'
import { TEXT_OUTPUT, copyBetween, formatSize } from '../tools/common.ts'
import { leaseTools, type WorkspaceLocation } from '../tools/lease/index.ts'

/** One environment held by an agent. */
export interface HeldEntry {
  lease: Lease
  alias: string
  /** Attached to the session's mount lease (GUI tools only; returning it keeps the mount). */
  attached: boolean
  /** This entry holds the lease's GUI (its GUI tools are registered). */
  readonly gui: boolean
  /** Names of the tools currently registered for the entry. */
  readonly tools: string[]
  release(reason: string): Promise<void>
}

export interface BorrowingHooks {
  mountOf(agent: Agent): Pick<MountRecord, 'env' | 'map' | 'lease' | 'envId' | 'parent'> | undefined
  /** Mount lifecycle, to attach the GUI of mounts whose mode is `gui`. */
  mountEvents?: EventEmitter<MountingEvents> | undefined
  titleOf?(sessionId: string): string
}

export interface Borrowing {
  heldOf(agent: Agent): HeldEntry[]
  releaseLease(leaseId: string): Promise<boolean>
}

interface SessionRef {
  agent: Agent
  sessionId: string
  cwd: string
}

function sessionOf(exec: { agent?: unknown }): SessionRef {
  const agent = agentOf(exec)
  if (!agent) throw new Error('environment tools need an agent session')
  return { agent, sessionId: sessionIdOf(agent), cwd: agent.session.header.cwd }
}

/** A resolved transfer endpoint. */
interface Location extends WorkspaceLocation {
  path: string
  label: string
}

function describeEnv(env: Environment): string {
  const i = env.info
  return `${i?.os ?? '?'}${i?.arch ? `/${i.arch}` : ''}${i?.version ? `, ${i.version}` : ''}; user ${i?.user || '?'}; cwd ${i?.cwd || '?'}; shell ${i?.shell || '?'}`
}

interface WaitArgs {
  wait: boolean
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}

/** Mutable state behind a HeldEntry. */
interface Entry extends HeldEntry {
  gui: boolean
  tools: string[]
  setGui(on: boolean, opts: WaitArgs): Promise<void>
}

/** Install borrowing for every agent. */
export function installBorrowing(
  ctx: PluginContext,
  manager: EnvironmentManager,
  deps: Pick<HarnessDeps, 'defineTool' | 'createScope'>,
  hooks: BorrowingHooks,
): Borrowing {
  const { defineTool, createScope } = deps
  const held = new WeakMap<Agent, Map<string, Entry>>()
  const liveAgents = new Set<Agent>()
  const warn = (message: string) => {
    try {
      ctx.logger('environments').warn(message)
    } catch {
      // no logger
    }
  }

  const heldOf = (agent: Agent): Map<string, Entry> => {
    let m = held.get(agent)
    if (!m) {
      const entries = new Map<string, Entry>()
      m = entries
      held.set(agent, entries)
      liveAgents.add(agent)
      agent.ctx.effect(
        () => () => {
          liveAgents.delete(agent)
          for (const entry of entries.values()) entry.release('session closed').catch(() => {})
          entries.clear()
        },
        'environments: borrowed leases',
      )
    }
    return m
  }

  const persistHeld = (sessionId: string, agent: Agent) => {
    const own = [...(held.get(agent)?.values() ?? [])].filter(e => !e.attached)
    manager.setSessionSettings(sessionId, {
      held:
        own.length > 0
          ? own.map(e => ({ envId: e.lease.envId, alias: e.alias, ...(e.gui ? { gui: true } : {}) }))
          : undefined,
    })
  }

  /** The session's own workspace as an Environment (mounted env or host files). */
  const workspaceOf = async (
    exec: { agent?: unknown },
    sourceAlias?: string,
    filePath?: string,
  ): Promise<WorkspaceLocation> => {
    const { agent, cwd } = sessionOf(exec)
    if (sourceAlias && sourceAlias !== 'workspace') {
      const entry = heldOf(agent).get(sourceAlias)
      if (!entry) throw new Error(`no borrowed environment with alias "${sourceAlias}"`)
      return { env: entry.lease.env, cwd: entry.lease.env.info?.cwd }
    }
    const mount = hooks.mountOf(agent)
    if (mount) return { env: mount.env, cwd: mount.map.remoteRoot }
    const host = new HostEnvironment(cwd)
    return { env: host, cwd, hostPath: filePath ? host.resolvePath(filePath, cwd) : undefined }
  }

  /** Parse "alias:path" (alias of a borrowed env, or "workspace"). Plain paths mean the workspace. */
  const location = async (exec: { agent?: unknown }, spec: string): Promise<Location> => {
    const { agent } = sessionOf(exec)
    const m = /^([A-Za-z][A-Za-z0-9_]*):(.*)$/.exec(spec)
    const alias = m?.[1]
    if (m && alias && !/^[A-Za-z]$/.test(alias)) {
      const rest = m[2] || '.'
      if (alias === 'workspace') {
        const w = await workspaceOf(exec)
        return { ...w, path: w.env.resolvePath(rest, w.cwd), label: 'workspace' }
      }
      const entry = heldOf(agent).get(alias)
      if (!entry) {
        throw new Error(
          `"${alias}" is not a borrowed environment of this session (borrowed: ${[...heldOf(agent).keys()].join(', ') || 'none'})`,
        )
      }
      const env = entry.lease.env
      return { env, cwd: env.info?.cwd, path: env.resolvePath(rest, env.info?.cwd), label: alias }
    }
    const w = await workspaceOf(exec)
    return { ...w, path: w.env.resolvePath(spec, w.cwd), label: 'workspace' }
  }

  const freeAlias = (m: Map<string, Entry>, base: string) => {
    let alias = base
    for (let i = 2; m.has(alias); i++) alias = `${base}_${i}`
    return alias
  }

  /**
   * Create an entry for a lease: register its headless tools unless attached, and its GUI tools
   * whenever it holds the GUI. `release` drops the entry (and the lease, unless attached).
   */
  const makeEntry = (agent: Agent, lease: Lease, alias: string, attached: boolean): Entry => {
    const m = heldOf(agent)
    const sessionId = sessionIdOf(agent)
    const built = leaseTools({ ctx, defineTool, lease, alias, workspaceOf })
    let headlessScope: HarnessScope | undefined
    let guiScope: HarnessScope | undefined
    const register = (list: typeof built.headless): HarnessScope => {
      const scope = createScope(ctx, agent)
      try {
        for (const t of list) scope.ctx.tools.register(t)
      } catch (e) {
        void scope.dispose()
        throw e
      }
      return scope
    }
    const toolNames = () => [
      ...(attached ? [] : built.headless.map(t => t.name)),
      ...(entry.gui ? built.gui.map(t => t.name) : []),
    ]
    const dropGui = async () => {
      const scope = guiScope
      guiScope = undefined
      entry.gui = false
      entry.tools = toolNames()
      await scope?.dispose().catch(() => {})
      await manager.setGui(lease, sessionId, false)
    }
    let releasing: Promise<void> | undefined
    const entry: Entry = {
      lease,
      alias,
      attached,
      gui: false,
      tools: [],
      async setGui(on, { wait, timeoutMs, signal }) {
        if (on === entry.gui) return
        if (!on) {
          await dropGui()
          return
        }
        await manager.setGui(lease, sessionId, true, { wait, timeoutMs, signal })
        if (releasing) {
          await manager.setGui(lease, sessionId, false)
          throw new Error(`${lease.def.name} was returned meanwhile`)
        }
        try {
          guiScope = register(built.gui)
        } catch (e) {
          await manager.setGui(lease, sessionId, false)
          throw e
        }
        entry.gui = true
        entry.tools = toolNames()
      },
      release: why =>
        (releasing ??= (async () => {
          if (m.get(alias) === entry) m.delete(alias)
          await built.dispose().catch(() => {})
          await dropGui().catch(() => {})
          await headlessScope?.dispose().catch(() => {})
          if (!attached) await lease.release(why)
          persistHeld(sessionId, agent)
          // Only the model (or user) giving the GUI back changes the mount's mode; a lost mount or
          // a closed session keeps it for the remount / resume.
          if (attached && why === 'returned') manager.setSessionSettings(sessionId, { mountGui: false })
        })()),
    }
    if (!attached) {
      headlessScope = register(built.headless)
      entry.tools = toolNames()
    }
    lease.once('release', why => {
      if (m.get(alias) === entry) void entry.release(why)
    })
    return entry
  }

  /** Borrow for an agent and register the lease's tools in its own agent scope. */
  const borrow = async (
    agent: Agent,
    envId: string,
    {
      gui,
      guiFallback = false,
      wait,
      timeoutMs,
      signal,
      reason,
    }: WaitArgs & { gui: boolean; guiFallback?: boolean; reason?: string | undefined },
  ): Promise<{ entry: Entry; guiError?: string }> => {
    const m = heldOf(agent)
    const sessionId = sessionIdOf(agent)
    const def = manager.require(envId)
    const lease = await manager.acquire(def.id, {
      owner: { sessionId, title: hooks.titleOf?.(sessionId) ?? sessionId, reason },
      purpose: 'borrow',
      // A GUI lease is taken in one step (it queues as one request); with a fallback the GUI is
      // tried separately so a busy GUI still yields a headless lease.
      mode: gui && !guiFallback ? 'gui' : 'headless',
      wait,
      timeoutMs,
      signal,
    })
    const alias = freeAlias(m, aliasFor(def.id))
    let entry: Entry
    try {
      entry = makeEntry(agent, lease, alias, false)
    } catch (e) {
      await lease.release('registration failed')
      throw e
    }
    m.set(alias, entry)
    let guiError: string | undefined
    if (gui) {
      try {
        // Adopts the GUI the lease was acquired with, or tries it now for the fallback.
        await entry.setGui(true, { wait: false })
      } catch (e) {
        if (!guiFallback) {
          await entry.release('registration failed')
          throw e
        }
        guiError = errorMessage(e)
      }
    }
    persistHeld(sessionId, agent)
    return { entry, guiError }
  }

  /** Attach a GUI entry to the agent's mount lease (takes the mount's GUI). */
  const attachMount = async (agent: Agent, lease: Lease, opts: WaitArgs): Promise<Entry> => {
    const m = heldOf(agent)
    const sessionId = sessionIdOf(agent)
    const entry = makeEntry(agent, lease, freeAlias(m, lease.alias), true)
    await entry.setGui(true, opts)
    if (lease.released) {
      await entry.release('mount lost')
      throw new Error(`the mount of ${lease.def.name} was lost`)
    }
    m.set(entry.alias, entry)
    manager.setSessionSettings(sessionId, { mountGui: true })
    return entry
  }

  // A mount whose environment mounts in GUI mode (or whose session held the GUI before it was
  // resumed) takes the GUI right away, without waiting; when the GUI is busy it stays headless.
  hooks.mountEvents?.on('mounted', (agent, record) => {
    const sessionId = sessionIdOf(agent)
    const saved = manager.sessionSettings(sessionId).mountGui
    const wanted = saved ?? (!record.parent && manager.mountModeOf(record.lease.def) === 'gui')
    if (!wanted) return
    attachMount(agent, record.lease, { wait: false }).catch((e: unknown) =>
      warn(`mount of ${sessionId} stays headless: ${errorMessage(e)}`),
    )
  })
  hooks.mountEvents?.on('unmounted', (agent, record) => {
    for (const e of [...(held.get(agent)?.values() ?? [])]) {
      if (e.attached && e.lease === record.lease) void e.release('unmounted')
    }
  })

  const allowedFor = (sessionId: string, cwd: string) => manager.borrowableFor(sessionId, cwd)

  const matches = (d: EnvironmentDefinition, name: string) => d.id === name || d.name === name || aliasFor(d.id) === name

  const modeText = (e: HeldEntry) => (e.gui ? 'GUI' : 'headless')

  ctx.tools.register(
    defineTool({
      name: 'env_list',
      description:
        'List the environments (devices/machines) this session may borrow, their status (including who holds their GUI), and the ones it currently holds.',
      parameters: {},
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const { agent, sessionId, cwd } = sessionOf(exec)
        await manager.refreshDiscovery()
        const { defs, source } = allowedFor(sessionId, cwd)
        const mine = heldOf(agent)
        const mount = hooks.mountOf(agent)
        const lines = defs.map(d => {
          const st = manager.status(d)
          const holding = [...mine.values()].find(e => e.lease.envId === d.id && !e.attached)
          const who = (h: { title: string | undefined; sessionId: string | undefined }) => h.title ?? h.sessionId
          const parts: string[] = []
          if (holding) parts.push(`held by you as "${holding.alias}" (${modeText(holding)})`)
          else if (mount?.envId === d.id) parts.push('your mount')
          else if (st.busy)
            parts.push(`busy (exclusive; ${st.holders.map(who).join(', ')}${st.queue.length ? `; ${st.queue.length} waiting` : ''})`)
          else parts.push(st.holders.length ? `available headless (${st.holders.length} in use)` : 'available')
          if (st.gui && !holding?.gui) parts.push(`GUI held by ${st.gui.title ?? st.gui.sessionId ?? 'another session'}`)
          const guiQueue = st.queue.filter(q => q.mode === 'gui').length
          if (guiQueue && !st.busy) parts.push(`${guiQueue} waiting for the GUI`)
          if (!st.headlessParallel && !st.busy && !holding) parts.push('exclusive')
          return `- ${d.id}: ${d.name} [${d.kind}${d.description ? `, ${d.description}` : ''}] — ${parts.join('; ')}`
        })
        const attached = mount ? [...mine.values()].find(e => e.attached && e.lease === mount.lease) : undefined
        return [
          mount
            ? `This session is mounted on ${mount.env.name} (${mount.map.remoteRoot}${mount.parent ? ', shared with the parent session' : ''}); your normal file and shell tools already act there. ${attached ? `You hold its GUI (tools "${attached.alias}__*").` : `The mount is headless; env_borrow { environment: "${mount.envId}", gui: true } takes its GUI.`}`
            : undefined,
          `Borrowable environments (${source === 'all' ? 'all configured' : `${source} list`}):`,
          lines.join('\n') || '(none — the user can allow environments in the Environments panel)',
          mine.size
            ? `\nHeld now: ${[...mine.values()].map(e => `${e.alias} → ${e.lease.def.name} (${e.attached ? 'GUI of your mount' : modeText(e)})`).join(', ')}`
            : '',
        ]
          .filter(x => x !== undefined)
          .join('\n')
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'env_borrow',
      description: [
        'Borrow an environment (e.g. an Android device, a test machine, a Windows test account). On success a set of tools prefixed with the environment alias (e.g. "<alias>__exec", "<alias>__read_file", "<alias>__install_apk") becomes available from your next step. Return it with env_return when done.',
        'A lease is headless by default: files, commands, processes, tunnels and non-screen tools (install_apk, app, logcat). Headless leases of other sessions may run at the same time, unless the environment is exclusive.',
        'Pass gui: true only when you need to see or drive the screen: it adds "<alias>__screenshot", "<alias>__input", "<alias>__ui", "<alias>__windows" / "<alias>__device" (as the environment supports). Only one session at a time holds the GUI of an environment; with wait: true you queue for it.',
        'Calling env_borrow again on an environment you hold (or your mounted environment) with gui: true upgrades it to GUI; gui: false gives the GUI back but keeps the lease.',
      ].join(' '),
      parameters: {
        environment: { type: 'string', required: true, description: 'Environment id from env_list.' },
        gui: {
          type: 'boolean',
          description:
            'Also take the GUI (screen tools). Default false. On an environment you already hold: true upgrades, false downgrades, omitted keeps the mode.',
        },
        wait: {
          type: 'boolean',
          description: 'If it (or its GUI) is busy, wait in line instead of failing immediately (default false).',
        },
        timeout_seconds: { type: 'number', description: 'Maximum time to wait when wait=true (default 600).' },
        reason: { type: 'string', description: 'Short note shown to other sessions and the user, e.g. "e2e tests".' },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const { agent, sessionId, cwd } = sessionOf(exec)
        await manager.refreshDiscovery()
        const m = heldOf(agent)
        const mount = hooks.mountOf(agent)
        const waitArgs: WaitArgs = {
          wait: !!args.wait,
          timeoutMs: Math.max(1, Math.min(24 * 3600, args.timeout_seconds ?? 600)) * 1000,
          signal: exec.signal,
        }
        const { defs } = allowedFor(sessionId, cwd)
        const mountDef = mount ? manager.get(mount.envId) : undefined
        const def =
          defs.find(d => d.id === args.environment) ??
          (mountDef && matches(mountDef, args.environment) ? mountDef : undefined) ??
          defs.find(d => matches(d, args.environment)) ??
          [...m.values()].map(e => e.lease.def).find(d => matches(d, args.environment))
        if (!def) {
          const known = manager.get(args.environment)
          throw new Error(
            known
              ? `${known.name} is not in this session's borrowable list; ask the user to allow it`
              : `unknown environment "${args.environment}"; call env_list`,
          )
        }
        const gui = args.gui
        // Already held (borrowed): change the mode, or report it.
        const existing = [...m.values()].find(e => e.lease.envId === def.id && !e.attached)
        if (existing) {
          if (gui === true && !existing.gui) {
            await existing.setGui(true, waitArgs)
            persistHeld(sessionId, agent)
            return `Took the GUI of ${def.name} ("${existing.alias}"). Tools now: ${existing.tools.join(', ')}.`
          }
          if (gui === false && existing.gui) {
            await existing.setGui(false, waitArgs)
            persistHeld(sessionId, agent)
            return `Gave back the GUI of ${def.name}; "${existing.alias}" stays borrowed headless. Tools now: ${existing.tools.join(', ')}.`
          }
          return `You already hold ${def.name} as "${existing.alias}" (${modeText(existing)}). Tools: ${existing.tools.join(', ')}.`
        }
        // The mounted environment: its GUI attaches to the mount's lease.
        if (mount && mount.envId === def.id) {
          const attached = [...m.values()].find(e => e.attached && e.lease === mount.lease)
          if (gui === true) {
            if (attached) return `You already hold the GUI of your mount ${def.name}. Tools: ${attached.tools.join(', ')}.`
            const entry = await attachMount(agent, mount.lease, waitArgs)
            return `Took the GUI of your mounted environment ${def.name}. New tools: ${entry.tools.join(', ') || '(none: the environment has no screen tools)'}. env_return "${entry.alias}" gives the GUI back; the mount stays.`
          }
          if (gui === false && attached) {
            await attached.release('returned')
            return `Gave back the GUI of ${def.name}; the session stays mounted on it.`
          }
          return `This session is mounted on ${def.name}; your file and shell tools already act there${attached ? ' and you hold its GUI' : ''}. ${attached ? '' : 'Pass gui: true to take its GUI (screen tools).'}`.trim()
        }
        const { entry, guiError } = await borrow(agent, def.id, { ...waitArgs, gui: !!gui, reason: args.reason })
        const env = entry.lease.env
        return [
          `Borrowed ${def.name} as "${entry.alias}" (${modeText(entry)}; ${describeEnv(env)}).`,
          guiError ? `The GUI could not be taken: ${guiError}` : undefined,
          `New tools: ${entry.tools.join(', ')}.`,
          !entry.gui && (env.hasCap('screenshot') || env.kind === 'adb')
            ? 'Screen tools need the GUI: env_borrow again with gui: true.'
            : undefined,
          `Copy files between this session's workspace and the environment with env_transfer (e.g. source "app/build/outputs/apk/debug/app-debug.apk", destination "${entry.alias}:/data/local/tmp/app.apk").`,
          'Call env_return when you are done so others can use it.',
        ]
          .filter(x => x !== undefined)
          .join('\n')
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'env_return',
      description:
        'Return a borrowed environment. Its tools disappear and every process and tunnel opened through it is closed. With gui_only: true only the GUI is given back (the screen tools disappear, the lease stays headless). For your mounted environment this gives back its GUI; the mount itself stays.',
      parameters: {
        environment: {
          type: 'string',
          required: true,
          description: 'Alias or id of the borrowed environment, or "all".',
        },
        gui_only: {
          type: 'boolean',
          description: 'Only give back the GUI and keep the headless lease (default false).',
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const { agent, sessionId } = sessionOf(exec)
        const m = heldOf(agent)
        const targets =
          args.environment === 'all'
            ? [...m.values()]
            : [...m.values()].filter(e => e.alias === args.environment || e.lease.envId === args.environment)
        if (targets.length === 0) {
          const mount = hooks.mountOf(agent)
          if (mount && (mount.envId === args.environment || mount.lease.alias === args.environment)) {
            throw new Error(
              `${mount.env.name} is this session's mount and cannot be returned; you do not hold its GUI either`,
            )
          }
          throw new Error(`nothing borrowed as "${args.environment}" (borrowed: ${[...m.keys()].join(', ') || 'none'})`)
        }
        const out: string[] = []
        for (const e of targets) {
          if (e.attached) {
            await e.release('returned')
            out.push(`gave back the GUI of ${e.lease.def.name} (still mounted)`)
          } else if (args.gui_only) {
            if (e.gui) {
              await e.setGui(false, { wait: false })
              out.push(`gave back the GUI of ${e.lease.def.name} ("${e.alias}" stays headless)`)
            } else out.push(`${e.lease.def.name} holds no GUI`)
          } else {
            await e.release('returned')
            out.push(`returned ${e.lease.def.name}`)
          }
        }
        persistHeld(sessionId, agent)
        return `${out.join('; ')}.`.replace(/^./, c => c.toUpperCase())
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'env_transfer',
      description:
        'Copy a file or directory between this session\'s workspace and borrowed environments, or between two borrowed environments. Locations are "alias:/path" for a borrowed environment, or a plain path (or "workspace:path") for the session workspace.',
      parameters: {
        source: {
          type: 'string',
          required: true,
          description: 'Source location, e.g. "build/app.apk" or "pixel:/sdcard/Download/log.txt".',
        },
        destination: {
          type: 'string',
          required: true,
          description: 'Destination location (full target path, not just the directory).',
        },
        overwrite: { type: 'boolean', description: 'Replace existing files.' },
      },
      output: TEXT_OUTPUT,
      timeoutMs: 60 * 60 * 1000,
      async execute(args, exec) {
        const src = await location(exec, args.source)
        const dst = await location(exec, args.destination)
        let target = dst.path
        const dstStat = await dst.env.stat(target).catch(() => null)
        const srcStat = await src.env.stat(src.path)
        if (!srcStat) throw new Error(`source not found: ${args.source}`)
        if (dstStat?.type === 'dir' && srcStat.type === 'file')
          target = dst.env.path.join(target, src.env.path.basename(src.path))
        const started = Date.now()
        const r = await copyBetween(src.env, src.path, dst.env, target, {
          overwrite: !!args.overwrite,
          signal: exec.signal,
        })
        return `Copied ${r.files} file${r.files === 1 ? '' : 's'} (${formatSize(r.bytes)}) from ${src.label}:${src.path} to ${dst.label}:${target} in ${((Date.now() - started) / 1000).toFixed(1)}s.`
      },
    }),
  )

  // Restore borrowed environments when a session resumes, in the mode they had. A GUI that is
  // taken by then is not waited for: the lease comes back headless.
  ctx.on('agent/created', ({ agent }) => {
    const sessionId = sessionIdOf(agent)
    const settings = manager.sessionSettings(sessionId)
    if (!Array.isArray(settings.held) || settings.held.length === 0) return
    for (const h of settings.held) {
      borrow(agent, h.envId, { wait: false, gui: !!h.gui, guiFallback: true }).then(
        ({ guiError }) => {
          if (guiError) warn(`re-borrowed ${h.envId} headless: ${guiError}`)
        },
        (e: unknown) => {
          warn(`could not re-borrow ${h.envId}: ${errorMessage(e)}`)
          persistHeld(sessionId, agent)
        },
      )
    }
  })

  return {
    heldOf: agent => [...(held.get(agent)?.values() ?? [])],
    async releaseLease(leaseId) {
      for (const agent of liveAgents) {
        for (const e of held.get(agent)?.values() ?? []) {
          if (e.lease.id === leaseId && !e.attached) {
            await e.release('released by the user')
            return true
          }
        }
      }
      const lease = manager.leases.get(leaseId)
      if (lease) {
        await lease.release('released by the user')
        return true
      }
      return false
    },
  }
}
