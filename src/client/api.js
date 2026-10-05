// Browser-side access to the plugin's host API.
import { useCallback, useEffect, useRef, useState } from 'react'

export const ROUTE = 'api/environments'

export async function call(action, body = {}, signal) {
  const response = await fetch(ROUTE, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
    signal,
  })
  let data
  try {
    data = await response.json()
  } catch {
    throw new Error(`HTTP ${response.status}`)
  }
  if (!data.ok) {
    const error = new Error(data.error ?? `HTTP ${response.status}`)
    error.code = data.code
    throw error
  }
  return data.value
}

const listeners = new Set()
/** Ask every mounted state hook to refresh now (after a mutation anywhere in the UI). */
export function invalidate() {
  for (const l of listeners) l()
}

/** Poll the plugin state while the component is mounted and the tab is visible. */
export function useEnvState(sessionId, { intervalMs = 4000, discover = false } = {}) {
  const [state, setState] = useState({ data: undefined, error: undefined, loading: true })
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick(v => v + 1), [])
  const first = useRef(true)

  useEffect(() => {
    listeners.add(refresh)
    return () => listeners.delete(refresh)
  }, [refresh])

  useEffect(() => {
    let disposed = false
    let timer
    const controller = new AbortController()
    const load = async () => {
      try {
        const data = await call('state', { sessionId, discover: discover && first.current }, controller.signal)
        first.current = false
        if (!disposed) setState({ data, error: undefined, loading: false })
      } catch (error) {
        if (disposed || controller.signal.aborted) return
        setState(prev => ({ ...prev, error: error.message, loading: false }))
      }
      if (!disposed) timer = setTimeout(() => { if (document.visibilityState === 'visible') load(); else timer = setTimeout(load, intervalMs) }, intervalMs)
    }
    load()
    return () => {
      disposed = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [sessionId, tick, intervalMs, discover])

  return { ...state, refresh }
}

/** Run an async action with busy/error tracking. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(undefined)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const run = useCallback(async fn => {
    setBusy(true)
    setError(undefined)
    try {
      const value = await fn()
      invalidate()
      return value
    } catch (e) {
      if (mounted.current) setError(e.message)
      return undefined
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [])
  return { busy, error, run, clearError: () => setError(undefined) }
}
