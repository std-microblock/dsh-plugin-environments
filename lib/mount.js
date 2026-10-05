// Mounting: route a session's own file/shell tools into an environment.
import { MountMap, createEnvFileSystem, createEnvSubprocessRuntime } from './mount/providers.js'
import { TEXT_OUTPUT } from './tools/common.js'

/** Tools that would act on the harness host and are hidden from mounted sessions. */
const HOST_ONLY_TOOLS = [
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_list', 'terminal_close', 'terminal_signal',
  'lsp', 'load_workspace_dependencies', 'str_replace_editor',
]

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md']
const INSTRUCTION_MAX = 64 * 1024

function sectionOrder(sctx) {
  try {
    return sctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
  } catch {
    return 900
  }
}

/**
 * Load AGENTS.md-style instruction files from the project root (nearest ancestor with .git)
 * down to the mount root, outermost first.
 */
export async function loadInstructions(env, root) {
  const P = env.path
  let dirs = [root]
  const chain = [root]
  let dir = root
  for (let i = 0; i < 6; i++) {
    if (await env.stat(P.join(dir, '.git')).catch(() => null)) {
      dirs = [...chain]
      break
    }
    const parent = P.dirname(dir)
    if (parent === dir) break
    dir = parent
    chain.unshift(dir)
  }
  const parts = []
  let budget = INSTRUCTION_MAX
  for (const d of dirs) {
    for (const name of INSTRUCTION_FILES) {
      const file = P.join(d, name)
      const st = await env.stat(file).catch(() => null)
      if (st?.type !== 'file' || st.size === 0) continue
      const buf = await env.readFile(file, { maxBytes: 1024 * 1024 }).catch(() => undefined)
      if (!buf || buf.includes(0)) continue
      let text = buf.toString('utf8').replace(/^\uFEFF/, '').trim()
      if (!text) continue
      if (text.length > budget) text = `${text.slice(0, budget)}\n… (truncated)`
      budget -= text.length
      parts.push(`<instructions path="${file}">\n${text}\n</instructions>`)
      break
    }
    if (budget <= 0) break
  }
  if (parts.length === 0) return ''
  return `Project instructions from the mounted environment. Follow them like AGENTS.md instructions; files nearer the working directory take precedence.\n\n${parts.join('\n\n')}`
}

function shellArgv(env, argv) {
  const base = String(argv[0] ?? '').replace(/\\/g, '/').split('/').pop().toLowerCase()
  if (base === 'bash' && env.info?.os === 'android') return ['sh', ...argv.slice(1)]
  if (/^(pwsh|powershell)(\.exe)?$/.test(base) && env.family === 'windows') {
    const preferred = /pwsh/i.test(env.info?.shell ?? '') ? 'pwsh.exe' : 'powershell.exe'
    return [preferred, ...argv.slice(1)]
  }
  return argv
}

/**
 * @param {object} ctx
 * @param {import('./manager.js').EnvironmentManager} manager
 * @param {object} deps - harness modules
 */
export function installMounting(ctx, manager, deps) {
  const EnvFileSystem = createEnvFileSystem(deps)
  const BaseRuntime = createEnvSubprocessRuntime(deps)
  class EnvSubprocessRuntime extends BaseRuntime {
    spawnSpec(spec) {
      const s = super.spawnSpec(spec)
      return { ...s, argv: shellArgv(this.env, s.argv) }
    }
    async spawnTerminal(spec) {
      return super.spawnTerminal({ ...spec, argv: shellArgv(this.env, spec.argv) })
    }
  }

  /** agent -> mount record */
  const mounts = new WeakMap()
  const live = new Set()
  const log = (...a) => { try { ctx.logger('environments').info(...a) } catch {} }

  async function install(agent, mount) {
    const sessionId = agent.session.header.id ?? agent.session.id
    const lease = await manager.acquire(mount.envId, {
      owner: { sessionId, title: `mounted session ${sessionId.slice(0, 8)}` },
      purpose: 'mount', wait: false,
    })
    const env = lease.env
    let remoteRoot = mount.remoteRoot || env.info?.cwd
    try {
      remoteRoot = await env.realpath(remoteRoot)
    } catch {}
    const st = await env.stat(remoteRoot).catch(() => null)
    if (!st || st.type !== 'dir') {
      await lease.release('root missing')
      throw new Error(`mount root ${remoteRoot} does not exist in ${env.name}`)
    }
    const map = new MountMap({ env, hostRoot: mount.hostRoot ?? agent.session.header.cwd, remoteRoot })
    const scope = deps.createScope(ctx, agent)
    const realm = scope.ctx.isolate('fs').isolate('subprocess').isolate('shell').isolate('sandbox')
    const record = { env, map, lease, scope, envId: mount.envId, source: mount.source, startedAt: Date.now() }
    mounts.set(agent, record)
    live.add(agent)
    try {
      realm.plugin(EnvFileSystem, { map })
      realm.plugin(EnvSubprocessRuntime, { map })
      if (env.family === 'windows') {
        realm.plugin(deps.PwshLocal, { pwshPath: /pwsh/i.test(env.info?.shell ?? '') ? 'pwsh.exe' : 'powershell.exe' })
        realm.plugin(deps.ToolPwsh, {})
      } else {
        realm.plugin(deps.BashLocal, {})
        realm.plugin(deps.ToolBash, {})
      }
      realm.plugin(deps.ToolFs, {})
      if (deps.SkillFilesystem) realm.plugin(deps.SkillFilesystem, { providerName: 'environment', watch: false })

      registerSearchTools(scope.ctx, deps.defineTool, map)
      scope.ctx.systemPrompt.variable('cwd', () => remoteRoot)
      // Project instruction files live in the environment. The preset's own loader reads the
      // host placeholder directory, so they are projected here as a prompt section instead.
      const instructions = { text: await loadInstructions(env, remoteRoot).catch(() => '') }
      let disposeInstructions = instructions.text
        ? scope.ctx.systemPrompt.section({ name: 'environments:instructions', order: sectionOrder(scope.ctx) + 1, interpolate: false, text: instructions.text })
        : undefined
      scope.ctx.on('tools/result', (exec, result) => {
        if (exec.agent !== agent || result.isError || !['write', 'edit'].includes(exec.name)) return
        const p = String(exec.arguments?.file_path ?? '')
        if (!INSTRUCTION_FILES.includes(p.replace(/\\/g, '/').split('/').pop())) return
        loadInstructions(env, remoteRoot).then(text => {
          if (text === instructions.text || mounts.get(agent) !== record) return
          instructions.text = text
          disposeInstructions?.()
          disposeInstructions = text
            ? scope.ctx.systemPrompt.section({ name: 'environments:instructions', order: sectionOrder(scope.ctx) + 1, interpolate: false, text })
            : undefined
        }, () => {})
      })
      scope.ctx.systemPrompt.section({
        name: 'environments:mount',
        order: sectionOrder(scope.ctx),
        interpolate: false,
        text: [
          `This session is mounted on the environment "${env.name}" (${env.info?.os}${env.info?.arch ? `/${env.info.arch}` : ''}, user ${env.info?.user ?? '?'}).`,
          `Your file tools (read, write, edit, read_image, glob, grep) and your ${env.family === 'windows' ? 'pwsh' : 'bash'} tool operate inside that environment; the working directory is ${remoteRoot}.`,
          `Use paths in the environment's own form (${env.family === 'windows' ? 'e.g. C:\\path\\file' : 'e.g. /path/file'}).`,
          'Use env_list / env_borrow to access additional devices.',
        ].join('\n'),
      })
      const visible = new Set(ctx.tools.schemas(agent).map(t => t.name))
      const deny = [...HOST_ONLY_TOOLS, env.family === 'windows' ? 'bash' : 'pwsh'].filter(n => visible.has(n))
      if (deny.length > 0) {
        try { scope.ctx.tools.restrict({ deny }) } catch (e) { log('restrict failed: %s', e.message) }
      }
      lease.once('release', reason => {
        if (mounts.get(agent) === record && !record.uninstalling) {
          log('mount of %s lost: %s', sessionId, reason)
          uninstall(agent).catch(() => {})
        }
      })
      agent.ctx.effect(() => () => { if (mounts.get(agent) === record) uninstall(agent).catch(() => {}) }, 'environments: mount')
    } catch (e) {
      await uninstall(agent)
      throw e
    }
    return record
  }

  async function uninstall(agent) {
    const record = mounts.get(agent)
    if (!record) return
    record.uninstalling = true
    mounts.delete(agent)
    live.delete(agent)
    await record.scope.dispose().catch(() => {})
    await record.lease.release('unmounted').catch(() => {})
  }

  async function ensure(agent) {
    const sessionId = agent.session.header.id ?? agent.session.id
    const want = manager.mountFor(sessionId, agent.session.header.cwd)
    const have = mounts.get(agent)
    if (have && want && have.envId === want.envId && (!want.remoteRoot || have.map.remoteRoot === want.remoteRoot || have.requestedRoot === want.remoteRoot)) return have
    if (have) await uninstall(agent)
    if (!want) return undefined
    const record = await install(agent, want)
    record.requestedRoot = want.remoteRoot
    return record
  }

  ctx.on('agent/created', async ({ agent }) => {
    try {
      await ensure(agent)
    } catch (e) {
      const sessionId = agent.session.header.id ?? agent.session.id
      manager.setSessionSettings(sessionId, { mountError: e.message })
      log('mount failed for %s: %s', sessionId, e.message)
    }
  })

  return {
    mountOf: agent => mounts.get(agent),
    ensure,
    uninstall,
    liveMounts: () => [...live].map(agent => ({ agent, record: mounts.get(agent) })).filter(x => x.record),
  }
}

/** glob/grep for mounted sessions, backed by the environment's native search. */
function registerSearchTools(sctx, defineTool, map) {
  const env = map.env
  sctx.tools.register(defineTool({
    name: 'glob',
    description: 'Find files by glob pattern (e.g. "**/*.ts", "src/**/test_*.py"). Results are paths relative to the search directory, newest first.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Glob pattern.' },
      path: { type: 'string', description: 'Directory to search (default: the working directory).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const base = map.resolve(args.path ?? '.', exec.agent?.session.header.cwd)
      const r = await env.glob(args.pattern, { cwd: base, limit: 200, signal: exec.signal })
      if (r.paths.length === 0) return 'No files found'
      return `${r.paths.join('\n')}${r.truncated ? '\n(Results are truncated. Use a more specific path or pattern.)' : ''}`
    },
  }))
  sctx.tools.register(defineTool({
    name: 'grep',
    description: 'Search file contents with a regular expression. Returns matching lines as path:line: text.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regular expression (Rust/ripgrep syntax where available).' },
      path: { type: 'string', description: 'File or directory to search (default: the working directory).' },
      include: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts".' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
      files_only: { type: 'boolean', description: 'Only list matching file paths.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = map.resolve('.', exec.agent?.session.header.cwd)
      const r = await env.grep(args.pattern, {
        cwd,
        path: args.path ? map.resolve(args.path, exec.agent?.session.header.cwd) : undefined,
        glob: args.include,
        ignoreCase: args.ignore_case,
        filesOnly: args.files_only,
        limit: 250,
        signal: exec.signal,
      })
      if (args.files_only) return r.files.join('\n') || 'No files found'
      if (r.matches.length === 0) return 'No files found'
      const byFile = new Map()
      for (const m of r.matches) {
        if (!byFile.has(m.path)) byFile.set(m.path, [])
        byFile.get(m.path).push(`  Line ${m.line}: ${m.text}`)
      }
      const lines = [`Found ${r.matches.length} matches${r.truncated ? ' (truncated)' : ''}`]
      for (const [file, ms] of byFile) lines.push('', `${file}:`, ...ms)
      return lines.join('\n')
    },
  }))
}
