// Borrowing: env_list / env_borrow / env_return / env_transfer plus per-lease tool sets.
import { TEXT_OUTPUT, copyBetween, formatSize } from './tools/common.js'
import { leaseTools } from './tools/lease-tools.js'
import { HostEnvironment } from './hostfs.js'
import { aliasFor } from './manager.js'

function sessionOf(exec) {
  const agent = exec.agent
  if (!agent) throw new Error('environment tools need an agent session')
  return { agent, sessionId: agent.session.header.id ?? agent.session.id, cwd: agent.session.header.cwd }
}

/**
 * Install borrowing for every agent.
 * @param {object} ctx - plugin context
 * @param {import('./manager.js').EnvironmentManager} manager
 * @param {object} deps - { defineTool, createScope }
 * @param {object} hooks - { mountOf(agent) => {env, map}|undefined, titleOf(sessionId) }
 */
export function installBorrowing(ctx, manager, deps, hooks) {
  const { defineTool, createScope } = deps
  /** agent -> Map<alias, { lease, scope, dispose }> */
  const held = new WeakMap()
  const liveAgents = new Set()

  const heldOf = agent => {
    let m = held.get(agent)
    if (!m) {
      m = new Map()
      held.set(agent, m)
      liveAgents.add(agent)
      agent.ctx.effect(() => () => {
        liveAgents.delete(agent)
        for (const entry of m.values()) entry.release('session closed').catch(() => {})
        m.clear()
      }, 'environments: borrowed leases')
    }
    return m
  }

  const persistHeld = (sessionId, agent) => {
    const m = held.get(agent)
    manager.setSessionSettings(sessionId, { held: m && m.size > 0 ? [...m.values()].map(e => ({ envId: e.lease.envId, alias: e.lease.alias })) : undefined })
  }

  /** The session's own workspace as an Environment (mounted env or host files). */
  const workspaceOf = async (exec, sourceAlias, filePath) => {
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
  const location = async (exec, spec) => {
    const { agent } = sessionOf(exec)
    const m = /^([A-Za-z][A-Za-z0-9_]*):(.*)$/.exec(spec)
    if (m && !/^[A-Za-z]$/.test(m[1])) {
      const alias = m[1]
      if (alias === 'workspace') {
        const w = await workspaceOf(exec)
        return { ...w, path: w.env.resolvePath(m[2] || '.', w.cwd), label: 'workspace' }
      }
      const entry = heldOf(agent).get(alias)
      if (!entry) throw new Error(`"${alias}" is not a borrowed environment of this session (borrowed: ${[...heldOf(agent).keys()].join(', ') || 'none'})`)
      const env = entry.lease.env
      return { env, path: env.resolvePath(m[2] || '.', env.info?.cwd), label: alias }
    }
    const w = await workspaceOf(exec)
    return { ...w, path: w.env.resolvePath(spec, w.cwd), label: 'workspace' }
  }

  const describeEnv = env => {
    const i = env.info ?? {}
    return `${i.os ?? '?'}${i.arch ? `/${i.arch}` : ''}${i.version ? `, ${i.version}` : ''}; user ${i.user || '?'}; cwd ${i.cwd || '?'}; shell ${i.shell || '?'}`
  }

  /** Borrow for an agent and register the lease's tools in its own agent scope. */
  const borrow = async (agent, envId, { wait, timeoutMs, signal, reason }) => {
    const m = heldOf(agent)
    const sessionId = agent.session.header.id ?? agent.session.id
    const def = manager.require(envId)
    let alias = aliasFor(def.id)
    for (let i = 2; m.has(alias); i++) alias = `${aliasFor(def.id)}_${i}`
    const lease = await manager.acquire(def.id, {
      owner: { sessionId, title: hooks.titleOf?.(sessionId) ?? sessionId, reason },
      purpose: 'borrow', wait, timeoutMs, signal, alias,
    })
    const scope = createScope(ctx, agent)
    const built = leaseTools({ ctx, defineTool, lease, workspaceOf })
    try {
      for (const t of built.tools) scope.ctx.tools.register(t)
    } catch (e) {
      await scope.dispose()
      await lease.release('registration failed')
      throw e
    }
    let releasing
    const entry = {
      lease,
      tools: built.tools.map(t => t.name),
      release: reason => (releasing ??= (async () => {
        m.delete(alias)
        await built.dispose().catch(() => {})
        await scope.dispose().catch(() => {})
        await lease.release(reason)
        persistHeld(sessionId, agent)
      })()),
    }
    lease.once('release', why => { if (m.get(alias) === entry) entry.release(why) })
    m.set(alias, entry)
    persistHeld(sessionId, agent)
    return entry
  }

  const allowedFor = (sessionId, cwd) => manager.borrowableFor(sessionId, cwd)

  ctx.tools.register(defineTool({
    name: 'env_list',
    description: 'List the environments (devices/machines) this session may borrow, their status, and the ones it currently holds.',
    parameters: {},
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const { agent, sessionId, cwd } = sessionOf(exec)
      await manager.refreshDiscovery()
      const { defs, source } = allowedFor(sessionId, cwd)
      const mine = heldOf(agent)
      const lines = defs.map(d => {
        const st = manager.status(d)
        const holding = [...mine.values()].find(e => e.lease.envId === d.id)
        const state = holding ? `held by you as "${holding.lease.alias}"` : st.busy ? `busy (${st.holders.map(h => h.title ?? h.sessionId).join(', ')}${st.queue.length ? `; ${st.queue.length} waiting` : ''})` : 'available'
        return `- ${d.id}: ${d.name} [${d.kind}${d.description ? `, ${d.description}` : ''}] — ${state}`
      })
      const mount = hooks.mountOf(agent)
      return [
        mount ? `This session is mounted on ${mount.env.name} (${mount.map.remoteRoot}); your normal file and shell tools already act there.` : undefined,
        `Borrowable environments (${source === 'all' ? 'all configured' : `${source} list`}):`,
        lines.join('\n') || '(none — the user can allow environments in the Environments panel)',
        mine.size ? `\nBorrowed now: ${[...mine.values()].map(e => `${e.lease.alias} → ${e.lease.def.name}`).join(', ')}` : '',
      ].filter(x => x !== undefined).join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'env_borrow',
    description: 'Borrow an environment (e.g. an Android device, a test machine, a Windows test account) for exclusive use. On success a set of tools prefixed with the environment alias (e.g. "<alias>__exec", "<alias>__screenshot", "<alias>__install_apk") becomes available from your next step. Return it with env_return when done.',
    parameters: {
      environment: { type: 'string', required: true, description: 'Environment id from env_list.' },
      wait: { type: 'boolean', description: 'If it is busy, wait in line instead of failing immediately (default false).' },
      timeout_seconds: { type: 'number', description: 'Maximum time to wait when wait=true (default 600).' },
      reason: { type: 'string', description: 'Short note shown to other sessions and the user, e.g. "e2e tests".' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const { agent, sessionId, cwd } = sessionOf(exec)
      await manager.refreshDiscovery()
      const { defs } = allowedFor(sessionId, cwd)
      const def = defs.find(d => d.id === args.environment) ?? defs.find(d => d.name === args.environment || aliasFor(d.id) === args.environment)
      if (!def) {
        const known = manager.get(args.environment)
        throw new Error(known ? `${known.name} is not in this session's borrowable list; ask the user to allow it` : `unknown environment "${args.environment}"; call env_list`)
      }
      const entry = await borrow(agent, def.id, {
        wait: !!args.wait,
        timeoutMs: Math.max(1, Math.min(24 * 3600, args.timeout_seconds ?? 600)) * 1000,
        signal: exec.signal,
        reason: args.reason,
      })
      const env = entry.lease.env
      return [
        `Borrowed ${def.name} as "${entry.lease.alias}" (${describeEnv(env)}).`,
        `New tools: ${entry.tools.join(', ')}.`,
        `Copy files between this session's workspace and the environment with env_transfer (e.g. source "app/build/outputs/apk/debug/app-debug.apk", destination "${entry.lease.alias}:/data/local/tmp/app.apk").`,
        'Call env_return when you are done so others can use it.',
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'env_return',
    description: 'Return a borrowed environment. Its tools disappear and every process and tunnel opened through it is closed.',
    parameters: {
      environment: { type: 'string', required: true, description: 'Alias or id of the borrowed environment, or "all".' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const { agent } = sessionOf(exec)
      const m = heldOf(agent)
      const targets = args.environment === 'all' ? [...m.values()] : [...m.values()].filter(e => e.lease.alias === args.environment || e.lease.envId === args.environment)
      if (targets.length === 0) throw new Error(`nothing borrowed as "${args.environment}" (borrowed: ${[...m.keys()].join(', ') || 'none'})`)
      for (const e of targets) await e.release('returned')
      return `Returned ${targets.map(e => e.lease.def.name).join(', ')}.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'env_transfer',
    description: 'Copy a file or directory between this session\'s workspace and borrowed environments, or between two borrowed environments. Locations are "alias:/path" for a borrowed environment, or a plain path (or "workspace:path") for the session workspace.',
    parameters: {
      source: { type: 'string', required: true, description: 'Source location, e.g. "build/app.apk" or "pixel:/sdcard/Download/log.txt".' },
      destination: { type: 'string', required: true, description: 'Destination location (full target path, not just the directory).' },
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
      if (dstStat?.type === 'dir' && srcStat.type === 'file') target = dst.env.path.join(target, src.env.path.basename(src.path))
      const started = Date.now()
      const r = await copyBetween(src.env, src.path, dst.env, target, { overwrite: !!args.overwrite, signal: exec.signal })
      return `Copied ${r.files} file${r.files === 1 ? '' : 's'} (${formatSize(r.bytes)}) from ${src.label}:${src.path} to ${dst.label}:${target} in ${((Date.now() - started) / 1000).toFixed(1)}s.`
    },
  }))

  // Restore borrowed environments when a session resumes.
  ctx.on('agent/created', async ({ agent }) => {
    const sessionId = agent.session.header.id ?? agent.session.id
    const settings = manager.sessionSettings(sessionId)
    if (!Array.isArray(settings.held) || settings.held.length === 0) return
    for (const h of settings.held) {
      borrow(agent, h.envId, { wait: false }).catch(e => {
        ctx.logger?.('environments')?.warn?.(`could not re-borrow ${h.envId}: ${e.message}`)
        persistHeld(sessionId, agent)
      })
    }
  })

  return {
    heldOf: agent => [...(held.get(agent)?.values() ?? [])],
    async releaseLease(leaseId) {
      for (const agent of liveAgents) {
        for (const e of held.get(agent)?.values() ?? []) if (e.lease.id === leaseId) { await e.release('released by the user'); return true }
      }
      const lease = manager.leases.get(leaseId)
      if (lease) { await lease.release('released by the user'); return true }
      return false
    },
  }
}
