// Actions of the HTTP API used by the browser UI (one POST body = one action call).
import os from 'node:os'
import path from 'node:path'
import { EnvError, errorCode, errorMessage, type Info } from '@dsh-environments/protocol'
import { ACCOUNT_RE, createWindowsAccount, deleteWindowsAccount, listWindowsAccounts } from '../env/winuser/accounts.ts'
import type { Borrowing } from '../borrowing/index.ts'
import type { PluginContext } from '../host-api.ts'
import { reverseCommands, sanitizeReverseSettings } from '../env/server/reverse.ts'
import type { DefinitionInput, EnvironmentDefinition } from '../manager/definitions.ts'
import type { EnvironmentManager } from '../manager/manager.ts'
import type { SessionMount, SessionSettings } from '../manager/state.ts'
import type { Mounting } from '../mount/index.ts'

/** Public subset of an environment's Info. */
export function describeInfo(info: Info | undefined) {
  if (!info) return undefined
  return {
    os: info.os,
    family: info.family,
    arch: info.arch,
    hostname: info.hostname,
    user: info.user,
    home: info.home,
    cwd: info.cwd,
    shell: info.shell,
    caps: info.caps,
    version: info.version,
    pathSep: info.pathSep,
  }
}

interface InfoCacheEntry {
  info?: Info | undefined
  error?: string
  at: number
}

/** Request body of an action; fields are validated by each action. */
export type ActionBody = Record<string, unknown>

export type Action = (body: ActionBody) => Promise<unknown>

export interface ApiDeps {
  mounting: Mounting
  borrowing: Borrowing
  mountsDir: string
}

/** A request field as a string (numbers and booleans are converted; anything else is absent). */
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined
/** A request field as a string, empty when absent. */
const text = (v: unknown): string => str(v) ?? ''

export function createActions(
  ctx: PluginContext,
  manager: EnvironmentManager,
  { mounting, borrowing, mountsDir }: ApiDeps,
): Record<string, Action> {
  const infoCache = new Map<string, InfoCacheEntry>()

  const agentFor = (sessionId: string) => {
    try {
      return ctx.get('agents')?.get(sessionId)
    } catch {
      return undefined
    }
  }

  const sessionState = (sessionId: string | undefined) => {
    if (!sessionId) return undefined
    const agent = agentFor(sessionId)
    const settings = manager.sessionSettings(sessionId)
    const cwd = agent?.session.header.cwd ?? settings.cwd
    const mount = manager.mountFor(sessionId, cwd)
    const record = agent ? mounting.mountOf(agent) : undefined
    const borrowable = manager.borrowableFor(sessionId, cwd)
    const held = agent
      ? borrowing.heldOf(agent).map(e => ({ ...e.lease.describe(), name: e.lease.def.name, tools: e.tools.length }))
      : []
    let started = false
    try {
      started = !!agent && agent.session.requestHeader?.() !== undefined
    } catch {
      // not started
    }
    return {
      sessionId,
      live: !!agent,
      cwd,
      mount: mount ? { envId: mount.envId, remoteRoot: mount.remoteRoot, source: mount.source } : undefined,
      mountExplicitlyOff: settings.mount === false,
      mountActive: record
        ? { envId: record.envId, remoteRoot: record.map.remoteRoot, since: record.startedAt }
        : undefined,
      mountError: settings.mountError,
      borrowableSource: borrowable.source,
      borrowable: borrowable.defs.map(d => d.id),
      borrowableExplicit: Array.isArray(settings.borrowable) ? settings.borrowable : undefined,
      held,
      started,
    }
  }

  const state: Action = async ({ sessionId, discover }) => {
    await manager.refreshDiscovery(!!discover)
    const defs = manager.definitions().map(d => ({
      ...manager.publicDef(d),
      status: manager.status(d),
      info: describeInfo(infoCache.get(d.id)?.info),
      lastError: infoCache.get(d.id)?.error,
      ...(d.kind === 'reverse' ? { connection: manager.reverse.state(d.id) } : {}),
    }))
    return {
      platform: process.platform,
      environments: defs,
      discovered: { adb: manager.discovered.adb, adbError: manager.discovered.adbError },
      remoteWorkspaces: manager.state.remoteWorkspaces,
      workspaces: manager.state.workspaces,
      leases: [...manager.leases.values()].map(l => ({ ...l.describe(), name: l.def.name })),
      session: sessionState(str(sessionId)),
      reverse: { ...manager.reverse.describe(), settings: manager.reverseSettings() },
    }
  }

  /** The secret of a reverse environment and the commands that use it (shown once). */
  const reveal = (def: EnvironmentDefinition, secret: string) => ({
    secret,
    ...reverseCommands({ id: def.id, secret, status: manager.reverse.describe(), cwd: def.config.cwd }),
  })

  return {
    state,
    async save({ environment }) {
      const input = environment as DefinitionInput
      const previous = input.id ? manager.get(String(input.id))?.config.token : undefined
      const def = manager.upsert(input)
      infoCache.delete(def.id)
      const fresh = def.kind === 'reverse' && def.config.token && def.config.token !== previous
      return { environment: manager.publicDef(def), ...(fresh ? { reverse: reveal(def, def.config.token ?? '') } : {}) }
    },
    async 'reverse.rotate'({ id }) {
      const def = manager.require(text(id))
      const secret = manager.rotateReverseSecret(def.id)
      return { reverse: reveal(def, secret) }
    },
    async 'reverse.settings'({ settings }) {
      if (settings !== undefined) await manager.setReverseSettings(sanitizeReverseSettings(settings))
      return { status: manager.reverse.describe(), settings: manager.reverseSettings() }
    },
    async delete({ id }) {
      const envId = text(id)
      for (const l of manager.leasesOf(envId)) await l.release('environment deleted')
      manager.remove(envId)
      return {}
    },
    async test({ id }) {
      const envId = text(id)
      const def = manager.require(envId)
      const started = Date.now()
      try {
        const env = await manager.open(def)
        const info = env.info
        await env.close()
        infoCache.set(envId, { info, at: Date.now() })
        return { ok: true, info: describeInfo(info), ms: Date.now() - started }
      } catch (e) {
        infoCache.set(envId, { error: errorMessage(e), at: Date.now() })
        return { ok: false, error: errorMessage(e), code: errorCode(e) }
      }
    },
    async 'fs.list'({ envId, path: p }) {
      const id = text(envId)
      return manager.browse(id, async env => {
        const info = env.info
        const target = p ? env.resolvePath(text(p), info?.cwd) : info?.cwd || info?.home || ''
        const entries = (await env.readdir(target)).map(e => ({
          name: e.name,
          type: e.type,
          size: e.size,
          mtimeMs: e.mtimeMs,
        }))
        const parent = env.path.dirname(target)
        infoCache.set(id, { info, at: Date.now() })
        return {
          path: target,
          parent: parent === target ? undefined : parent,
          entries,
          sep: info?.pathSep,
          home: info?.home,
          cwd: info?.cwd,
          info: describeInfo(info),
        }
      })
    },
    async 'fs.mkdir'({ envId, path: p }) {
      return manager.browse(text(envId), async env => {
        await env.mkdir(text(p), { recursive: true })
        return {}
      })
    },
    async 'remoteWorkspace.create'({ envId, root, title }) {
      if (!root) throw new EnvError('EINVAL', 'root is required')
      const ws = manager.addRemoteWorkspace({ envId: text(envId), root: text(root), title: str(title), mountsDir })
      const registry = ctx.get('workspaceRegistry')
      let workspaceId: string | undefined
      if (registry) {
        const created = await registry.create(ws.hostPath, ws.title)
        workspaceId = created.id
        ws.workspaceId = workspaceId
        manager.save()
      }
      return { workspace: ws, workspaceId }
    },
    async 'remoteWorkspace.delete'({ id }) {
      const ws = manager.removeRemoteWorkspace(text(id))
      const registry = ctx.get('workspaceRegistry')
      if (ws?.workspaceId && registry) {
        try {
          await registry.delete(ws.workspaceId)
        } catch {
          // already gone
        }
      }
      return {}
    },
    async 'session.set'({ sessionId, mount, borrowable, cwd }) {
      const sid = str(sessionId)
      if (!sid) throw new EnvError('EINVAL', 'sessionId is required')
      if (mount !== undefined && sessionState(sid)?.started) {
        throw new EnvError('EINVAL', 'the session has already started; its mount can no longer change')
      }
      const patch: { [K in keyof SessionSettings]?: SessionSettings[K] | undefined } = {}
      if (mount !== undefined) {
        const m = mount as SessionMount | false | null
        patch.mount = m === null ? undefined : m === false ? false : { envId: m.envId, remoteRoot: m.remoteRoot }
        patch.mountError = undefined
      }
      if (borrowable !== undefined)
        patch.borrowable = borrowable === null ? undefined : (borrowable as unknown[]).map(String)
      if (cwd) patch.cwd = text(cwd)
      manager.setSessionSettings(sid, patch)
      const agent = agentFor(sid)
      if (agent && mount !== undefined) {
        try {
          await mounting.ensure(agent)
        } catch (e) {
          manager.setSessionSettings(sid, { mountError: errorMessage(e) })
          throw e
        }
      }
      return { session: sessionState(sid) }
    },
    async 'workspace.set'({ workspacePath, workspaceId, borrowable }) {
      let p = str(workspacePath)
      if (!p && workspaceId) p = ctx.get('workspaceRegistry')?.get(text(workspaceId))?.path
      if (!p) throw new EnvError('EINVAL', 'workspace not found')
      return {
        settings: manager.setWorkspaceSettings(p, {
          borrowable: borrowable === null ? undefined : (borrowable as string[] | undefined),
        }),
      }
    },
    async 'lease.release'({ leaseId }) {
      return { released: await borrowing.releaseLease(text(leaseId)) }
    },
    async 'winuser.list'() {
      return { accounts: await listWindowsAccounts(), supported: process.platform === 'win32' }
    },
    async 'winuser.create'({ name, environmentName, grantPaths }) {
      const account = str(name) ?? ''
      if (!ACCOUNT_RE.test(account)) {
        throw new EnvError('EINVAL', 'account name must be 1-20 letters, digits, _ or -, starting with a letter')
      }
      await createWindowsAccount(account, {
        dataDir: manager.dataDir,
        grantPaths: Array.isArray(grantPaths) ? grantPaths.map(String) : [],
      })
      const def = manager.upsert({
        id: `win_${account.toLowerCase()}`,
        name: str(environmentName) || `Windows · ${account}`,
        kind: 'winuser',
        config: { account },
        description: `Local account ${account}`,
      })
      return { environment: manager.publicDef(def) }
    },
    async 'winuser.delete'({ name }) {
      const account = text(name)
      for (const d of manager.state.environments.filter(e => e.kind === 'winuser' && e.config.account === account)) {
        for (const l of manager.leasesOf(d.id)) await l.release('account deleted')
        manager.remove(d.id)
      }
      await deleteWindowsAccount(account, { dataDir: manager.dataDir })
      return {}
    },
    async defaults() {
      return { home: os.homedir(), mountsDir, sep: path.sep }
    },
  }
}
