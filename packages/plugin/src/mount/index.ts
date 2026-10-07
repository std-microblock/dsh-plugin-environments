// Mounting: route a session's own file/shell tools into an environment.
//
// Subagent children inherit their parent's mount: same environment and root, sharing the
// parent's lease (no second lease, so exclusive environments cannot deadlock between parent and
// child). The mount gate applies to them like to any mounted session.
import { EventEmitter } from 'node:events'
import { errorMessage } from '@dsh-environments/protocol'
import type { HarnessDeps, HarnessScope } from '../deps.ts'
import type { Environment } from '../env/environment.ts'
import { parentSessionOf, sessionIdOf, type Agent, type PluginContext } from '../host-api.ts'
import type { Lease } from '../manager/lease.ts'
import type { EnvironmentManager } from '../manager/manager.ts'
import type { EffectiveMount } from '../manager/state.ts'
import { createEnvFileSystem } from './fs-provider.ts'
import { installMountGate } from './gate.ts'
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
  /** The mount's lease; for a subagent, its parent's (shared, not released by this mount). */
  lease: Lease
  scope: HarnessScope
  envId: string
  source: EffectiveMount['source']
  startedAt: number
  requestedRoot?: string | undefined
  /** The parent agent whose mount (and lease) this subagent shares. */
  parent?: Agent | undefined
  uninstalling?: boolean
}

/** The mount an agent should have: its effective mount, inherited from its parent for subagents. */
export interface WantedMount extends EffectiveMount {
  /** Live parent agent whose mount is shared. */
  parent?: Agent | undefined
}

export interface MountingEvents {
  mounted: [Agent, MountRecord]
  unmounted: [Agent, MountRecord]
}

export interface Mounting {
  mountOf(agent: Agent): MountRecord | undefined
  /**
   * Bring the agent's mount in line with its settings (install, replace or remove it). A failure
   * is recorded as the session's `mountError` and rethrown; success clears it.
   */
  ensure(agent: Agent): Promise<MountRecord | undefined>
  uninstall(agent: Agent): Promise<void>
  /** Why the agent must not run: it should be mounted but is not (see `gate.ts`). */
  blockReason(agent: Agent): string | undefined
  /** The mount the agent should have (subagents: their parent's). */
  wantedOf(agent: Agent): WantedMount | undefined
  liveMounts(): { agent: Agent; record: MountRecord }[]
  readonly events: EventEmitter<MountingEvents>
}

/** Whether an installed mount satisfies the wanted one. */
function satisfies(have: MountRecord, want: WantedMount, parentRecord: MountRecord | undefined): boolean {
  if (want.parent) return have.parent === want.parent && !!parentRecord && have.lease === parentRecord.lease
  return (
    !have.parent &&
    have.envId === want.envId &&
    (!want.remoteRoot || have.map.remoteRoot === want.remoteRoot || have.requestedRoot === want.remoteRoot)
  )
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
  const events = new EventEmitter<MountingEvents>()
  const log = (format: string, ...args: unknown[]) => {
    try {
      ctx.logger('environments').info(format, ...args)
    } catch {
      // no logger
    }
  }
  const agentById = (id: string): Agent | undefined => {
    try {
      return ctx.get('agents')?.get(id)
    } catch {
      return undefined
    }
  }

  /**
   * The mount an agent should have. A subagent child inherits its parent's (recursively): it
   * shares the parent's live mount, or — when the parent is not running — follows the parent's
   * settings with a lease of its own. Anything else follows its own settings.
   */
  function wantedOf(agent: Agent, depth = 0): WantedMount | undefined {
    const parentId = parentSessionOf(agent)
    if (parentId && depth < 16) {
      const parent = agentById(parentId)
      if (parent) {
        const want = wantedOf(parent, depth + 1)
        return want ? { ...want, parent } : undefined
      }
      return manager.mountFor(parentId, agent.session.header.cwd)
    }
    return manager.mountFor(sessionIdOf(agent), agent.session.header.cwd)
  }

  async function install(agent: Agent, mount: WantedMount): Promise<MountRecord> {
    const sessionId = sessionIdOf(agent)
    const parentRecord = mount.parent ? mounts.get(mount.parent) : undefined
    if (mount.parent && !parentRecord) {
      throw new Error(`父会话的挂载不可用（${manager.get(mount.envId)?.name ?? mount.envId}）`)
    }
    const lease =
      parentRecord?.lease ??
      (await manager.acquire(mount.envId, {
        owner: { sessionId, title: `mounted session ${sessionId.slice(0, 8)}` },
        purpose: 'mount',
        wait: false,
      }))
    const env = lease.env
    let remoteRoot = parentRecord?.map.remoteRoot ?? (mount.remoteRoot || env.info?.cwd || '')
    if (!parentRecord) {
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
    }
    const map = new MountMap({
      env,
      hostRoot: parentRecord?.map.hostRoot ?? mount.hostRoot ?? agent.session.header.cwd,
      remoteRoot,
    })
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
      requestedRoot: mount.remoteRoot,
      parent: parentRecord ? mount.parent : undefined,
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
          ...(record.parent ? ['This mount is shared with the parent session that delegated to you.'] : []),
          ...(env.hasCap('screenshot') || env.kind === 'adb'
            ? [
                `The mount is headless unless this session holds the environment's GUI: screen tools (${lease.alias}__screenshot, ${lease.alias}__input, ...) exist only then. Take the GUI with env_borrow { environment: "${mount.envId}", gui: true } and give it back with env_return; the mount itself stays.`,
              ]
            : []),
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
          // Recorded so the gate reports why the session is blocked until it is remounted.
          manager.setSessionSettings(sessionId, { mountError: `挂载已断开（${reason}）` })
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
    events.emit('mounted', agent, record)
    return record
  }

  async function uninstall(agent: Agent): Promise<void> {
    const record = mounts.get(agent)
    if (!record) return
    record.uninstalling = true
    mounts.delete(agent)
    live.delete(agent)
    events.emit('unmounted', agent, record)
    await record.scope.dispose().catch(() => {})
    // A subagent's mount shares its parent's lease, which stays with the parent.
    if (!record.parent) await record.lease.release('unmounted').catch(() => {})
  }

  async function reconcile(agent: Agent): Promise<MountRecord | undefined> {
    const sessionId = sessionIdOf(agent)
    let want = wantedOf(agent)
    let record: MountRecord | undefined
    try {
      // A shared mount needs the parent's mount in place first (it may be installing right now).
      if (want?.parent) {
        await ensure(want.parent).catch(() => undefined)
        want = wantedOf(agent)
      }
      const have = mounts.get(agent)
      const parentRecord = want?.parent ? mounts.get(want.parent) : undefined
      if (have && want && satisfies(have, want, parentRecord)) record = have
      else {
        if (have) await uninstall(agent)
        record = want ? await install(agent, want) : undefined
      }
    } catch (e) {
      manager.setSessionSettings(sessionId, { mountError: errorMessage(e) })
      throw e
    }
    if (manager.sessionSettings(sessionId).mountError !== undefined) {
      manager.setSessionSettings(sessionId, { mountError: undefined })
    }
    return record
  }

  // One reconciliation at a time per agent: creation, the turn gate and the GUI may race.
  const pending = new WeakMap<Agent, Promise<unknown>>()
  function ensure(agent: Agent): Promise<MountRecord | undefined> {
    const previous = pending.get(agent) ?? Promise.resolve()
    const run = previous.then(() => reconcile(agent))
    const tracked = run
      .catch(() => undefined)
      .finally(() => {
        if (pending.get(agent) === tracked) pending.delete(agent)
      })
    pending.set(agent, tracked)
    return run
  }

  function blockReason(agent: Agent): string | undefined {
    const sessionId = sessionIdOf(agent)
    const want = wantedOf(agent)
    if (!want) return undefined
    const have = mounts.get(agent)
    if (have && satisfies(have, want, want.parent ? mounts.get(want.parent) : undefined)) return undefined
    const name = manager.get(want.envId)?.name ?? want.envId
    const error = manager.sessionSettings(sessionId).mountError
    if (error !== undefined) return `环境 ${name} 挂载失败：${error}`
    return pending.has(agent) ? `环境 ${name} 正在挂载，请稍后再试` : `环境 ${name} 挂载失败：未挂载`
  }

  ctx.on('agent/created', async ({ agent }) => {
    try {
      await ensure(agent)
    } catch (e) {
      // Recorded as the session's mountError; the gate keeps the session from running unmounted.
      log('mount failed for %s: %s', sessionIdOf(agent), errorMessage(e))
    }
  })
  installMountGate(ctx, { ensure, blockReason })

  return {
    mountOf: agent => mounts.get(agent),
    ensure,
    uninstall,
    blockReason,
    wantedOf,
    events,
    liveMounts: () =>
      [...live].flatMap(agent => {
        const record = mounts.get(agent)
        return record ? [{ agent, record }] : []
      }),
  }
}

export { loadInstructions } from './instructions.ts'
export { MountMap } from './map.ts'
export { installMountGate, MountBlockedError } from './gate.ts'
export { createEnvFileSystem } from './fs-provider.ts'
export { createEnvSubprocessRuntime } from './subprocess-provider.ts'
