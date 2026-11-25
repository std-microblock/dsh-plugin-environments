// The mount gate: a session that should be mounted but is not must not run on the host.
//
// Mounting replaces a session's own file and shell providers inside its scope. When that fails
// (or the mount is lost later) the session's tools would fall back to the harness host: the
// placeholder directory of a remote workspace, the host shell. Instead of letting that happen,
// two hooks hold the session back until its mount is in place:
//
// - `agent/pre-step`: before every model step, a blocked session first re-attempts its mount
//   (the environment may be back) and, if it still fails, the step throws. The agent loop ends
//   the turn with that error, so the model is never called and the GUI shows the reason.
// - `tools/pre-execute`: tool calls of a blocked session are denied. This closes the window in
//   which a mount is lost in the middle of a step whose tool calls were already proposed.
//
// A mount whose connection dropped stays installed while its lease reconnects; both hooks first
// wait a little for the connection (`settle`), so a short outage does not end the turn.
import type { Agent, PluginContext } from '../host-api.ts'

/** Error ending a turn of a session whose mount is missing ("环境 X 挂载失败：…"). */
export class MountBlockedError extends Error {
  override name = 'MountBlockedError'
}

export interface MountGateTarget {
  /** Re-attempt the agent's mount; rejects when it fails. */
  ensure(agent: Agent): Promise<unknown>
  /** Why the agent must not run now, or undefined when it may. */
  blockReason(agent: Agent): string | undefined
  /** Wait (briefly) for a mount connection that is being re-established. */
  settle?(agent: Agent, signal?: AbortSignal): Promise<void>
}

/** Settle with `promise`, or reject with the abort reason as soon as `signal` aborts (cancelled turn). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason as Error)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export function installMountGate(ctx: PluginContext, target: MountGateTarget): void {
  ctx.on('agent/pre-step', async (event, next) => {
    if (target.blockReason(event.agent) !== undefined) {
      if (target.settle) await untilAborted(target.settle(event.agent, event.signal), event.signal)
    }
    if (target.blockReason(event.agent) !== undefined) {
      await untilAborted(
        target.ensure(event.agent).catch(() => undefined),
        event.signal,
      )
      const reason = target.blockReason(event.agent)
      if (reason !== undefined) throw new MountBlockedError(reason)
    }
    return next()
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec.agent
    let reason = agent ? target.blockReason(agent) : undefined
    if (agent && reason !== undefined && target.settle) {
      await target.settle(agent).catch(() => undefined)
      reason = target.blockReason(agent)
    }
    if (reason !== undefined) return { kind: 'deny', reason }
    return next()
  })
}
