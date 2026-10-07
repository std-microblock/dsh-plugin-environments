// Display names of environments.
import type { Translate } from './host-api.ts'
import type { EnvView } from './types.ts'

/**
 * Name shown for an environment. The built-in `local` environment is a separate dsh-env-server
 * process on this computer; it is named apart from "本机" / "This computer", which is where an
 * unmounted session runs.
 */
export function envName(env: Pick<EnvView, 'name' | 'kind' | 'builtin'> | undefined, t: Translate): string {
  if (!env) return ''
  return env.builtin && env.kind === 'local' ? t('env.builtinLocal') : env.name
}
