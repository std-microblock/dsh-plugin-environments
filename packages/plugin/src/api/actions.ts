// Actions of the HTTP API used by the browser UI (one POST body = one action call).
import os from 'node:os'
import path from 'node:path'
import { EnvError, errorCode, errorMessage, type Info } from '@dsh-environments/protocol'
import {
  ACCOUNT_RE,
  createWindowsAccount,
  deleteWindowsAccount,
  listWindowsAccounts,
  runServerElevated,
} from '../env/winuser/accounts.ts'
import type { Environment } from '../env/environment.ts'
import { probeSession, termwrapPayload } from '../env/winuser/session-mode.ts'
import type { Borrowing } from '../borrowing/index.ts'
import { reverseCommands, sanitizeReverseSettings } from '../env/server/reverse.ts'
import { sessionStarted, type PluginContext } from '../host-api.ts'
import { AvailabilityChecker } from '../manager/availability.ts'
import type { DefinitionInput, EnvironmentDefinition } from '../manager/definitions.ts'
import type { EnvironmentManager } from '../manager/manager.ts'
import type { SessionMount, SessionSettings, WorkspaceSettings } from '../manager/state.ts'
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
  /** Availability checker (tests inject one with stubbed probes). */
  availability?: AvailabilityChecker | undefined
}

/** A request field as a string (numbers and booleans are converted; anything else is absent). */
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined
/** A request field as a string, empty when absent. */
const text = (v: unknown): string => str(v) ?? ''

export function createActions(
  ctx: PluginContext,
  manager: EnvironmentManager,
  { mounting, borrowing, mountsDir, availability = new AvailabilityChecker(manager) }: ApiDeps,
): Record<string, Action> {
  const infoCache = new Map<string, InfoCacheEntry>()

  /** Host path of a workspace given by path or by DSH workspace id. */
  const workspacePathOf = (workspacePath: unknown, workspaceId: unknown): string => {
    let p = str(workspacePath)
    if (!p && workspaceId) {
      const id = text(workspaceId)
      p =
        ctx.get('workspaceRegistry')?.get(id)?.path ??
        manager.state.remoteWorkspaces.find(w => w.workspaceId === id)?.hostPath
    }
    if (!p) throw new EnvError('EINVAL', 'workspace not found')
    return p
  }

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
    const record = agent ? mounting.mountOf(agent) : undefined
    const borrowable = manager.borrowableFor(sessionId, cwd)
    const held = agent
      ? borrowing.heldOf(agent).map(e => ({ ...e.lease.describe(), name: e.lease.def.name, tools: e.tools.length }))
      : []
    const started = !!agent && sessionStarted(agent)
    const mount = manager.mountFor(sessionId, cwd)
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
      /** Set while the session cannot run because its mount is missing (the turn error it gets). */
      mountBlocked: agent ? mounting.blockReason(agent) : undefined,
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
      availability.invalidate(def.id)
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
      availability.invalidate(envId)
      return {}
    },
    async test({ id }) {
      const envId = text(id)
      const def = manager.require(envId)
      const started = Date.now()
      availability.invalidate(envId)
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
    /**
     * One live frame of an environment's desktop for the Environments page viewer.
     *
     * A connection a live lease already holds is preferred: that is the desktop the agent is
     * actually working on. For a `session`-mode account opening a second connection would start a
     * *second* session, so the viewer asks for a running session instead of inventing one. Every
     * other environment falls back to the same short-lived browse connection the file browser
     * uses (a private desktop is created on demand and closed again once the viewer stops asking).
     */
    async 'desktop.frame'({ envId, maxWidth, cursor }) {
      const id = text(envId)
      if (!id) throw new EnvError('EINVAL', 'envId is required')
      const width = Math.min(Math.max(Math.round(Number(maxWidth) || 960), 120), 2560)
      const frame = async (env: Environment) => {
        if (!env.hasCap('screenshot')) {
          throw new EnvError('UNSUPPORTED', `${env.name} cannot show a desktop`)
        }
        const shot = await env.capture({ maxWidth: width, cursor: cursor !== false })
        if (!shot.png) throw new EnvError('EIO', `${env.name} returned no image`)
        const desktopName = (env as { desktopName?: string }).desktopName
        return {
          mime: 'image/png',
          data: shot.png.toString('base64'),
          width: shot.width,
          height: shot.height,
          desktop: desktopName ?? null,
          cursor: shot.cursor ?? null,
          at: Date.now(),
        }
      }
      const leased = manager.leasesOf(id)[0]?.env
      if (leased && !leased.closed) return await frame(leased)
      const def = manager.require(id)
      if (def.kind === 'winuser' && def.config.desktop === 'session') {
        throw new EnvError(
          'EBUSY',
          'this account has no session running right now; start one from a session before watching its desktop',
        )
      }
      return await manager.browse(id, frame)
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
      // A failure is recorded as the session's mountError (and blocks its turns).
      if (agent && mount !== undefined) await mounting.ensure(agent)
      return { session: sessionState(sid) }
    },
    /** Re-attempt the mount of a live session (after it failed or was lost). */
    async 'session.remount'({ sessionId }) {
      const sid = str(sessionId)
      if (!sid) throw new EnvError('EINVAL', 'sessionId is required')
      const agent = agentFor(sid)
      if (!agent) throw new EnvError('EINVAL', 'the session is not running')
      await mounting.ensure(agent)
      return { session: sessionState(sid) }
    },
    /** Change a workspace's default borrowable list: `borrowable` (string[], or null = every environment). */
    async 'workspace.set'({ workspacePath, workspaceId, borrowable }) {
      const p = workspacePathOf(workspacePath, workspaceId)
      let settings: WorkspaceSettings = manager.workspaceSettings(p)
      if (borrowable !== undefined) {
        settings = manager.setWorkspaceSettings(p, {
          borrowable: Array.isArray(borrowable) ? borrowable.map(String) : null,
        })
      }
      return { settings, binding: manager.workspaceBinding(p, str(workspaceId)) }
    },
    /**
     * Bindings of the workspaces the GUI lists, with the availability of every bound environment.
     * Body: `{ workspaces: [{ workspaceId, path }] }`.
     */
    async 'workspace.bindings'({ workspaces }) {
      const items = Array.isArray(workspaces) ? (workspaces as unknown[]) : []
      const bindings = items.flatMap(item => {
        if (!item || typeof item !== 'object') return []
        const record = item as Record<string, unknown>
        const workspaceId = str(record['workspaceId'])
        let p = str(record['path'])
        if (!p && workspaceId) {
          try {
            p = workspacePathOf(undefined, workspaceId)
          } catch {
            // unknown workspace: skipped
          }
        }
        if (!p) return []
        return [{ workspaceId, path: p, ...manager.workspaceBinding(p, workspaceId) }]
      })
      await manager.refreshDiscovery(false)
      const envIds = [...new Set(bindings.flatMap(b => (b.envId ? [b.envId] : [])))]
      const availabilityById = await availability.check(envIds)
      const environments = envIds.flatMap(id => {
        const def = manager.get(id)
        return def ? [{ id: def.id, name: def.name, kind: def.kind }] : []
      })
      return { bindings, availability: availabilityById, environments }
    },
    async 'lease.release'({ leaseId }) {
      return { released: await borrowing.releaseLease(text(leaseId)) }
    },
    /**
     * Install the TermWrap payload (elevated) so this machine can host one session per isolated
     * account. Always needs a reboot: the wrapper DLL is loaded by the Terminal Services service
     * at start-up. The payload travels inside our own release package (MIT, plain files), so the
     * install needs no network access.
     */
    async 'session.install'() {
      if (process.platform !== 'win32') {
        throw new EnvError('UNSUPPORTED', 'TermWrap can only be installed on a Windows host')
      }
      const payload = termwrapPayload()
      if (!payload.present) {
        throw new EnvError(
          'ENOENT',
          'this build was packaged without the TermWrap payload; install TermWrap manually (see docs/session-mode.md)',
        )
      }
      const result = await runServerElevated(['session', 'install', '--payload', payload.dir])
      return { ...result, payloadVersion: payload.version }
    },
    /**
     * Let an account log on through Remote Desktop (elevated), which is what the session logon
     * needs. Idempotent: an account that is already a member is fine.
     */
    async 'session.allow'({ account }) {
      if (process.platform !== 'win32') {
        throw new EnvError('UNSUPPORTED', 'Remote Desktop logon is only available on Windows')
      }
      const name = str(account) ?? ''
      if (!ACCOUNT_RE.test(name)) throw new EnvError('EINVAL', 'a valid account name is required')
      return await runServerElevated(['session', 'allow', '--account', name])
    },
    async 'winuser.list'() {
      return { accounts: await listWindowsAccounts(), supported: process.platform === 'win32' }
    },
    /**
     * Whether this machine can host a separate session per isolated account, and whether the
     * TermWrap payload needed for it shipped with this build.
     */
    async 'session.status'() {
      const payload = termwrapPayload()
      const termwrap = {
        present: payload.present,
        version: payload.version,
        license: payload.license,
        files: payload.files,
      }
      if (process.platform !== 'win32') {
        return {
          ok: true,
          ready: false,
          missing: ['not-windows'],
          reasons: ['real sessions are only available on Windows hosts'],
          termwrap,
        }
      }
      const probe = await probeSession()
      return { ...probe, termwrap }
    },
    async 'winuser.create'({ name, environmentName, grantPaths, desktop }) {
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
        // The desktop choice made while creating the account must survive into the definition,
        // otherwise a fresh account would silently fall back to the human's desktop.
        config: { account, desktop: str(desktop) === 'private' ? 'private' : 'shared' },
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
      return await deleteWindowsAccount(account, { dataDir: manager.dataDir })
    },
    async defaults() {
      return { home: os.homedir(), mountsDir, sep: path.sep }
    },
  }
}
