// Shared test helpers.
import { serverBinary } from '../src/env/server/connect.ts'

/**
 * `skip` option for tests that need a dsh-env-server binary (built with `pnpm build:server`).
 * CI sets DSH_ENV_SERVER_REQUIRED=1 so a missing binary fails the run instead of skipping.
 */
export const needsServer: { skip: string | false } = (() => {
  try {
    serverBinary()
    return { skip: false }
  } catch (e) {
    if (process.env['DSH_ENV_SERVER_REQUIRED']) throw e
    return { skip: 'dsh-env-server binary not found (run pnpm build:server or set DSH_ENV_SERVER_BIN)' }
  }
})()
