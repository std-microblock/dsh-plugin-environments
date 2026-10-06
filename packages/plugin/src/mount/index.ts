// Mounting: route a session's own file/shell tools into an environment.
import { errorMessage } from '@dsh-environments/protocol'
import type { HarnessDeps, HarnessScope } from '../deps.ts'
import type { Environment } from '../env/environment.ts'
import { sessionIdOf, sessionStarted, type Agent, type PluginContext } from '../host-api.ts'
import type { Lease } from '../manager/lease.ts'
import type { EnvironmentManager } from '../manager/manager.ts'
import type { EffectiveMount } from '../manager/state.ts'
import { createEnvFileSystem } from './fs-provider.ts'
import { INSTRUCTION_FILES, loadInstructions } from './instructions.ts'
import { MountMap } from './map.ts'
import { registerSearchTools } from './search-tools.ts'
import { createEnvSubprocessRuntime, type EnvSpawnSpec } from './subprocess-provider.ts'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** Tools that would act on the harness host and are hidden from mounted sessions. */
const HOST_ONLY_TOOLS = [
  'terminal_open',
  'terminal_send',
  'terminal_read',
  'terminal_list',
  'terminal_close',
  'terminal_signal',
  'lsp',
  'load_workspace_dependencies',
  'str_replace_editor',
]

function sectionOrder(sctx: PluginContext): number {
  try {
    return sctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
  } catch {
    return 900
  }
}

/** Adjust shell argv to the environment: `sh` on Android, the available PowerShell on Windows. */
function shellArgv(env: Environment, argv: readonly string[]): string[] {
  const base = (
    String(argv[0] ?? '')
      .replace(/\\/g, '/')
      .split('/')
      .pop() ?? ''
  ).toLowerCase()
  if (base === 'bash' && env.info?.os === 'android') return ['sh', ...argv.slice(1)]
  if (/^(pwsh|powershell)(\.exe)?$/.test(base) && env.family === 'windows') {
    const preferred = /pwsh/i.test(env.info?.shell ?? '') ? 'pwsh.exe' : 'powershell.exe'
    return [preferred, ...argv.slice(1)]
  }
  return [...argv]
}

/** An active mount of one agent. */
export interface MountRecord {
  env: Environment
  map: MountMap
  lease: Lease
  scope: HarnessScope
  envId: string
  source: EffectiveMount['source']
  startedAt: number
  requestedRoot?: string | undefined
  uninstalling?: boolean
}

export interface Mounting {
  mountOf(agent: Agent): MountRecord | undefined
  ensure(agent: Agent): Promise<MountRecord | undefined>
  uninstall(agent: Agent): Promise<void>
  liveMounts(): { agent: Agent; record: MountRecord }[]
}

export function installMounting(ctx: PluginContext, manager: EnvironmentManager, deps: HarnessDeps): Mounting {
  const EnvFileSystem = createEnvFileSystem(deps)
  const BaseRuntime = createEnvSubprocessRuntime(deps)
  class EnvSubprocessRuntime extends BaseRuntime {
    override spawnSpec(spec: Parameters<InstanceType<typeof BaseRuntime>['spawnSpec']>[0]): EnvSpawnSpec {
      const s = super.spawnSpec(spec)
      return { ...s, argv: shellArgv(this.env, s.argv) }
    }
    override spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
      return super.spawnTerminal({ ...spec, argv: shellArgv(this.env, spec.argv) })
    }
  }

  const mounts = new WeakMap<Agent, MountRecord>()
  const live = new Set<Agent>()
  const log = (format: string, ...args: unknown[]) => {
    try {
      ctx.logger('environments').info(format, ...args)
    } catch {
      // no logger
    }
  }

  async function install(agent: Agent, mount: EffectiveMount): Promise<MountRecord> {
    const sessionId = sessionIdOf(agent)
    const lease = await manager.acquire(mount.envId, {
      owner: { sessionId, title: `mounted session ${sessionId.slice(0, 8)}` },
      purpose: 'mount',
      wait: false,
    })
    const env = lease.env
    let remoteRoot = mount.remoteRoot || env.info?.cwd || ''
    try {
      remoteRoot = await env.realpath(remoteRoot)
    } catch {
      // keep the requested spelling
    }
    const st = await env.stat(remoteRoot).catch(() => null)
    if (!st || st.type !== 'dir') {
      await lease.release('root missing')
      throw new Error(`mount root ${remoteRoot} does not exist in ${env.name}`)
    }
    const map = new MountMap({ env, hostRoot: mount.hostRoot ?? agent.session.header.cwd, remoteRoot })
    const scope = deps.createScope(ctx, agent)
    const realm = scope.ctx.isolate('fs').isolate('subprocess').isolate('shell').isolate('sandbox')
    const record: MountRecord = {
      env,
      map,
      lease,
      scope,
      envId: mount.envId,
      source: mount.source,
      startedAt: Date.now(),
    }
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
      const instructionSection = (text: string) =>
        scope.ctx.systemPrompt.section({
          name: 'environments:instructions',
          order: sectionOrder(scope.ctx) + 1,
          interpolate: false,
          text,
        })
      let disposeInstructions = instructions.text ? instructionSection(instructions.text) : undefined
      scope.ctx.on('tools/result', (exec, result) => {
        if (exec.agent !== agent || result.isError || !['write', 'edit'].includes(exec.name)) return
        const filePath = exec.arguments?.['file_path']
        const p = typeof filePath === 'string' ? filePath : ''
        if (!INSTRUCTION_FILES.includes(p.replace(/\\/g, '/').split('/').pop() ?? '')) return
        loadInstructions(env, remoteRoot).then(
          text => {
            if (text === instructions.text || mounts.get(agent) !== record) return
            instructions.text = text
            disposeInstructions?.()
            disposeInstructions = text ? instructionSection(text) : undefined
          },
          () => {},
        )
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
        try {
          scope.ctx.tools.restrict({ deny })
        } catch (e) {
          log('restrict failed: %s', errorMessage(e))
        }
      }
      lease.once('release', reason => {
        if (mounts.get(agent) === record && !record.uninstalling) {
          log('mount of %s lost: %s', sessionId, reason)
          uninstall(agent).catch(() => {})
        }
      })
      agent.ctx.effect(
        () => () => {
          if (mounts.get(agent) === record) uninstall(agent).catch(() => {})
        },
        'environments: mount',
      )
    } catch (e) {
      await uninstall(agent)
      throw e
    }
    return record
  }

  async function uninstall(agent: Agent): Promise<void> {
    const record = mounts.get(agent)
    if (!record) return
    record.uninstalling = true
    mounts.delete(agent)
    live.delete(agent)
    await record.scope.dispose().catch(() => {})
    await record.lease.release('unmounted').catch(() => {})
  }

  async function ensure(agent: Agent): Promise<MountRecord | undefined> {
    const sessionId = sessionIdOf(agent)
    // The workspace default environment only applies to sessions that have not started yet.
    const want = manager.mountFor(sessionId, agent.session.header.cwd, { fresh: !sessionStarted(agent) })
    const have = mounts.get(agent)
    if (
      have &&
      want &&
      have.envId === want.envId &&
      (!want.remoteRoot || have.map.remoteRoot === want.remoteRoot || have.requestedRoot === want.remoteRoot)
    ) {
      return have
    }
    if (have) await uninstall(agent)
    if (!want) return undefined
    const record = await install(agent, want)
    record.requestedRoot = want.remoteRoot
    manager.seedDefaultMount(sessionId, want)
    return record
  }

  ctx.on('agent/created', async ({ agent }) => {
    try {
      await ensure(agent)
    } catch (e) {
      const sessionId = sessionIdOf(agent)
      manager.setSessionSettings(sessionId, { mountError: errorMessage(e) })
      log('mount failed for %s: %s', sessionId, errorMessage(e))
    }
  })

  return {
    mountOf: agent => mounts.get(agent),
    ensure,
    uninstall,
    liveMounts: () =>
      [...live].flatMap(agent => {
        const record = mounts.get(agent)
        return record ? [{ agent, record }] : []
      }),
  }
}

export { loadInstructions } from './instructions.ts'
export { MountMap } from './map.ts'
export { createEnvFileSystem } from './fs-provider.ts'
export { createEnvSubprocessRuntime } from './subprocess-provider.ts'
