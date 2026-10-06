// Browser-side access to the plugin's host API.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { StateView } from './types.ts'

export const ROUTE = 'api/environments'

/** An API failure; `code` is the host error code when there is one. */
export class ApiError extends Error {
  code: string | undefined
  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

interface ApiEnvelope {
  ok: boolean
  value?: unknown
  error?: string
  code?: string
}

/** Call one API action. The result type is the caller's expectation of that action's value. */
export async function call<T = unknown>(
  action: string,
  body: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(ROUTE, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
    ...(signal ? { signal } : {}),
  })
  let data: ApiEnvelope
  try {
    data = (await response.json()) as ApiEnvelope
  } catch {
    throw new Error(`HTTP ${response.status}`)
  }
  if (!data.ok) throw new ApiError(data.error ?? `HTTP ${response.status}`, data.code)
  return data.value as T
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const listeners = new Set<() => void>()
/** Ask every mounted state hook to refresh now (after a mutation anywhere in the UI). */
export function invalidate(): void {
  for (const l of listeners) l()
}

interface EnvState {
  data: StateView | undefined
  error: string | undefined
  loading: boolean
}

/** Poll the plugin state while the component is mounted and the tab is visible. */
export function useEnvState(
  sessionId: string | undefined,
  { intervalMs = 4000, discover = false }: { intervalMs?: number; discover?: boolean } = {},
): EnvState & { refresh: () => void } {
  const [state, setState] = useState<EnvState>({ data: undefined, error: undefined, loading: true })
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick(v => v + 1), [])
  const first = useRef(true)

  useEffect(() => {
    listeners.add(refresh)
    return () => {
      listeners.delete(refresh)
    }
  }, [refresh])

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const load = async () => {
      try {
        const data = await call<StateView>(
          'state',
          { sessionId, discover: discover && first.current },
          controller.signal,
        )
        first.current = false
        if (!disposed) setState({ data, error: undefined, loading: false })
      } catch (error) {
        if (disposed || controller.signal.aborted) return
        setState(prev => ({ ...prev, error: messageOf(error), loading: false }))
      }
      if (!disposed) {
        timer = setTimeout(() => {
          if (document.visibilityState === 'visible') void load()
          else timer = setTimeout(() => void load(), intervalMs)
        }, intervalMs)
      }
    }
    void load()
    return () => {
      disposed = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [sessionId, tick, intervalMs, discover])

  return { ...state, refresh }
}

export interface Action {
  busy: boolean
  error: string | undefined
  run<T>(fn: () => Promise<T>): Promise<T | undefined>
  clearError(): void
}

/** Run an async action with busy/error tracking. */
export function useAction(): Action {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )
  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError(undefined)
    try {
      const value = await fn()
      invalidate()
      return value
    } catch (e) {
      if (mounted.current) setError(messageOf(e))
      return undefined
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [])
  return { busy, error, run, clearError: () => setError(undefined) }
}
