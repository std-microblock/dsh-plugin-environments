// HTTP API used by the browser UI.
import { errorCode, errorMessage } from '@dsh-environments/protocol'
import type { EnvironmentManager } from '../manager/manager.ts'
import type { PluginContext } from '../host-api.ts'
import { createActions, type Action, type ActionBody, type ApiDeps } from './actions.ts'

export const ROUTE = '/api/environments'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export function installApi(
  ctx: PluginContext,
  manager: EnvironmentManager,
  deps: ApiDeps,
): { actions: Record<string, Action> } {
  const actions = createActions(ctx, manager, deps)

  const handle = async (request: Request): Promise<Response> => {
    let body: ActionBody
    try {
      body =
        request.method === 'GET'
          ? Object.fromEntries(new URL(request.url).searchParams)
          : (JSON.parse((await request.text()) || '{}') as ActionBody)
    } catch {
      return json({ ok: false, error: 'invalid JSON body' }, 400)
    }
    const name = String(body['action'])
    const action = Object.hasOwn(actions, name) ? actions[name] : undefined
    if (!action) return json({ ok: false, error: `unknown action ${name}` }, 400)
    try {
      return json({ ok: true, value: await action(body) })
    } catch (e) {
      return json({ ok: false, error: errorMessage(e), code: errorCode(e) })
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
