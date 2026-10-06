import type { ErrorCode } from './types.ts'

/** Error raised for a failed protocol operation (and by environments generally). */
export class EnvError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'EnvError'
    this.code = code
  }
}

/** Read the `code` of an unknown thrown value, if it has a string one. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

/** Read the message of an unknown thrown value (`String(error)` for non-errors). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message)
  }
  return String(error)
}
