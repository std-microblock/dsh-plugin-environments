// HTTP API used by the browser UI.
import os from 'node:os'
import path from 'node:path'
import { EnvError } from './protocol/client.js'
import { createWindowsAccount, deleteWindowsAccount, listWindowsAccounts, ACCOUNT_RE } from './env/winuser-env.js'

export const ROUTE = '/api/environments'

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

function describeInfo(info) {
  if (!info) return undefined
  return { os: info.os, family: info.family, arch: info.arch, hostname: info.hostname, user: info.user, home: info.home, cwd: info.cwd, shell: info.shell, caps: info.caps, version: info.version, pathSep: info.pathSep }
}

export function installApi(ctx, manager, { mounting, borrowing, mountsDir }) {
  const infoCache = new Map()

  const agentFor = sessionId => {
    try { return ctx.get('agents')?.get(sessionId) } catch { return undefined }
  }

  const sessionState = sessionId => {
    if (!sessionId) return undefined
    const agent = agentFor(sessionId)
    const settings = manager.sessionSettings(sessionId)
    const cwd = agent?.session.header.cwd ?? settings.cwd
    const mount = manager.mountFor(sessionId, cwd)
    const record = agent ? mounting.mountOf(agent) : undefined
    const borrowable = manager.borrowableFor(sessionId, cwd)
    const held = agent ? borrowing.heldOf(agent).map(e => ({ ...e.lease.describe(), name: e.lease.def.name, tools: e.tools.length })) : []
    let started = false
    try { started = !!agent && agent.session.requestHeader?.() !== undefined } catch {}
    return {
      sessionId,
      live: !!agent,
      cwd,
      mount: mount ? { envId: mount.envId, remoteRoot: mount.remoteRoot, source: mount.source } : undefined,
      mountExplicitlyOff: settings.mount === false,
      mountActive: record ? { envId: record.envId, remoteRoot: record.map.remoteRoot, since: record.startedAt } : undefined,
      mountError: settings.mountError,
      borrowableSource: borrowable.source,
      borrowable: borrowable.defs.map(d => d.id),
      borrowableExplicit: Array.isArray(settings.borrowable) ? settings.borrowable : undefined,
      held,
      started,
    }
  }

  const state = async ({ sessionId, discover }) => {
    await manager.refreshDiscovery(!!discover)
    const defs = manager.definitions().map(d => ({
      ...manager.publicDef(d),
      status: manager.status(d),
      info: describeInfo(infoCache.get(d.id)?.info),
      lastError: infoCache.get(d.id)?.error,
    }))
    return {
      platform: process.platform,
      environments: defs,
      discovered: { adb: manager.discovered.adb, adbError: manager.discovered.adbError },
      remoteWorkspaces: manager.state.remoteWorkspaces,
      workspaces: manager.state.workspaces,
      leases: [...manager.leases.values()].map(l => ({ ...l.describe(), name: l.def.name })),
      session: sessionState(sessionId),
    }
  }

  const actions = {
    state,
    async save({ environment }) {
      const def = manager.upsert(environment)
      infoCache.delete(def.id)
      return { environment: manager.publicDef(def) }
    },
    async delete({ id }) {
      for (const l of manager.leasesOf(id)) await l.release('environment deleted')
      manager.remove(id)
      return {}
    },
    async test({ id }) {
      const def = manager.require(id)
      const started = Date.now()
      try {
        const env = await manager.open(def)
        const info = env.info
        await env.close()
        infoCache.set(id, { info, at: Date.now() })
        return { ok: true, info: describeInfo(info), ms: Date.now() - started }
      } catch (e) {
        infoCache.set(id, { error: e.message, at: Date.now() })
        return { ok: false, error: e.message, code: e.code }
      }
    },
    async 'fs.list'({ envId, path: p }) {
      return manager.browse(envId, async env => {
        const target = p ? env.resolvePath(p, env.info.cwd) : env.info.cwd || env.info.home
        let entries = await env.readdir(target)
        entries = entries.map(e => ({ name: e.name, type: e.type, size: e.size, mtimeMs: e.mtimeMs }))
        const parent = env.path.dirname(target)
        infoCache.set(envId, { info: env.info, at: Date.now() })
        return { path: target, parent: parent === target ? undefined : parent, entries, sep: env.info.pathSep, home: env.info.home, cwd: env.info.cwd, info: describeInfo(env.info) }
      })
    },
    async 'fs.mkdir'({ envId, path: p }) {
      return manager.browse(envId, async env => { await env.mkdir(p, { recursive: true }); return {} })
    },
    async 'remoteWorkspace.create'({ envId, root, title }) {
      if (!root) throw new EnvError('EINVAL', 'root is required')
      const ws = manager.addRemoteWorkspace({ envId, root, title, mountsDir })
      const registry = ctx.get('workspaceRegistry')
      let workspaceId
      if (registry) {
        const created = await registry.create(ws.hostPath, ws.title)
        workspaceId = created.id
        ws.workspaceId = workspaceId
        manager.save()
      }
      return { workspace: ws, workspaceId }
    },
    async 'remoteWorkspace.delete'({ id }) {
      const ws = manager.removeRemoteWorkspace(id)
      const registry = ctx.get('workspaceRegistry')
      if (ws?.workspaceId && registry) {
        try { await registry.delete(ws.workspaceId) } catch {}
      }
      return {}
    },
    async 'session.set'({ sessionId, mount, borrowable, cwd }) {
      if (!sessionId) throw new EnvError('EINVAL', 'sessionId is required')
      if (mount !== undefined && sessionState(sessionId)?.started) {
        throw new EnvError('EINVAL', 'the session has already started; its mount can no longer change')
      }
      const patch = {}
      if (mount !== undefined) {
        patch.mount = mount === null ? undefined : mount === false ? false : { envId: mount.envId, remoteRoot: mount.remoteRoot }
        patch.mountError = undefined
      }
      if (borrowable !== undefined) patch.borrowable = borrowable === null ? undefined : borrowable.map(String)
      if (cwd) patch.cwd = cwd
      manager.setSessionSettings(sessionId, patch)
      const agent = agentFor(sessionId)
      if (agent && mount !== undefined) {
        try {
          await mounting.ensure(agent)
        } catch (e) {
          manager.setSessionSettings(sessionId, { mountError: e.message })
          throw e
        }
      }
      return { session: sessionState(sessionId) }
    },
    async 'workspace.set'({ workspacePath, workspaceId, borrowable }) {
      let p = workspacePath
      if (!p && workspaceId) p = ctx.get('workspaceRegistry')?.get(workspaceId)?.path
      if (!p) throw new EnvError('EINVAL', 'workspace not found')
      return { settings: manager.setWorkspaceSettings(p, { borrowable: borrowable === null ? undefined : borrowable }) }
    },
    async 'lease.release'({ leaseId }) {
      return { released: await borrowing.releaseLease(leaseId) }
    },
    async 'winuser.list'() {
      return { accounts: await listWindowsAccounts(), supported: process.platform === 'win32' }
    },
    async 'winuser.create'({ name, environmentName, grantPaths }) {
      if (!ACCOUNT_RE.test(name ?? '')) throw new EnvError('EINVAL', 'account name must be 1-20 letters, digits, _ or -, starting with a letter')
      await createWindowsAccount(name, { dataDir: manager.dataDir, grantPaths: Array.isArray(grantPaths) ? grantPaths : [] })
      const def = manager.upsert({ id: `win_${name.toLowerCase()}`, name: environmentName || `Windows · ${name}`, kind: 'winuser', config: { account: name }, description: `Local account ${name}` })
      return { environment: manager.publicDef(def) }
    },
    async 'winuser.delete'({ name }) {
      for (const d of manager.state.environments.filter(e => e.kind === 'winuser' && e.config?.account === name)) {
        for (const l of manager.leasesOf(d.id)) await l.release('account deleted')
        manager.remove(d.id)
      }
      await deleteWindowsAccount(name, { dataDir: manager.dataDir })
      return {}
    },
    async defaults() {
      return { home: os.homedir(), mountsDir, sep: path.sep }
    },
  }

  const handle = async request => {
    let body = {}
    try {
      body = request.method === 'GET' ? Object.fromEntries(new URL(request.url).searchParams) : JSON.parse(await request.text() || '{}')
    } catch {
      return json({ ok: false, error: 'invalid JSON body' }, 400)
    }
    const action = actions[body.action]
    if (!action) return json({ ok: false, error: `unknown action ${body.action}` }, 400)
    try {
      return json({ ok: true, value: await action(body) })
    } catch (e) {
      return json({ ok: false, error: e?.message ?? String(e), code: e?.code })
    }
  }

  ctx.inject(['connection'], scope => {
    scope.connection.fetch.register({
      path: ROUTE,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: request => handle(request),
    })
  })

  return { actions }
}
