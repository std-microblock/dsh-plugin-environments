// Shared test helpers.
import { serverBinary } from '../src/env/server/connect.ts'

/** `skip` option for tests that need a dsh-env-server binary (built with `pnpm build:server`). */
export const needsServer: { skip: string | false } = (() => {
  try {
    serverBinary()
    return { skip: false }
  } catch {
    return { skip: 'dsh-env-server binary not found (run pnpm build:server or set DSH_ENV_SERVER_BIN)' }
  }
})()
