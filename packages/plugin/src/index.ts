// dsh-plugin-environments: mount or borrow local, dsh-env-server, SSH, ADB and Windows-account environments.
import os from 'node:os'
import path from 'node:path'
import { installApi } from './api/index.ts'
import { installBorrowing } from './borrowing/index.ts'
import { loadDeps } from './deps.ts'
import type { Logger, PluginContext } from './host-api.ts'
import type { ReverseListenerSettings } from './env/server/reverse.ts'
import { EnvironmentManager } from './manager/manager.ts'
import { installMounting } from './mount/index.ts'

export const name = 'environments'
export const inject = ['tools', 'agents', 'systemPrompt']

/** Plugin configuration (all optional). */
export interface Config {
  /** Where definitions, settings and account secrets are stored. */
  dataDir?: string
  /** Where remote-workspace placeholder directories are created. */
  mountsDir?: string
  /** List devices from `adb devices` automatically (default true). */
  autoDiscoverAdb?: boolean
  /** adb executable (default `adb` on PATH). */
  adb?: string
  /**
   * Listeners for reverse connections (`dsh-env-server connect`), off by default. Settings
   * changed in the GUI take precedence.
   */
  reverse?: ReverseListenerSettings
}

function dshHome(): string {
  return process.env['DSH_HOME'] || path.join(os.homedir(), '.dsh')
}

export async function apply(ctx: PluginContext, config: Config = {}): Promise<void> {
  const deps = await loadDeps()
  const dataDir = config.dataDir || path.join(dshHome(), 'storages', 'environments')
  const mountsDir = config.mountsDir || path.join(dshHome(), 'env-mounts')
  let logger: Logger | undefined
  try {
    logger = ctx.logger('environments')
  } catch {
    // no logger service
  }
  const manager = new EnvironmentManager({
    dataDir,
    autoDiscoverAdb: config.autoDiscoverAdb !== false,
    adb: config.adb || 'adb',
    logger,
    reverse: config.reverse,
  })
  manager.load()
  void manager.startReverse().catch((e: unknown) => logger?.warn('environments: reverse listeners: %s', String(e)))
  ctx.effect(() => () => manager.dispose(), 'environments: manager')

  const titleOf = (sessionId: string) => sessionId.slice(0, 8)
  const mounting = installMounting(ctx, manager, deps)
  const borrowing = installBorrowing(ctx, manager, deps, { mountOf: agent => mounting.mountOf(agent), titleOf })
  installApi(ctx, manager, { mounting, borrowing, mountsDir })
}
