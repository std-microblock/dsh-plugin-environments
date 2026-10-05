// dsh-plugin-environments: mount or borrow local, dsh-env-server, SSH, ADB and Windows-account environments.
import os from 'node:os'
import path from 'node:path'
import { EnvironmentManager } from './manager.js'
import { installBorrowing } from './borrow.js'
import { installMounting } from './mount.js'
import { installApi } from './api.js'

export const name = 'environments'
export const inject = ['tools', 'agents', 'systemPrompt']

async function optionalImport(spec) {
  try {
    return await import(spec)
  } catch {
    return undefined
  }
}

/** Load the harness modules this plugin builds on (resolved from the running installation). */
async function loadDeps() {
  const [tools, scope, fsMod, subprocess, bashLocal, pwshLocal, toolBash, toolPwsh, toolFs, skills] = await Promise.all([
    import('@deepseek-ai/dsh-tools'),
    import('@deepseek-ai/dsh-scope'),
    import('@deepseek-ai/dsh-fs'),
    import('@deepseek-ai/dsh-subprocess'),
    import('@deepseek-ai/dsh-bash-local'),
    import('@deepseek-ai/dsh-pwsh-local'),
    import('@deepseek-ai/dsh-tool-bash'),
    import('@deepseek-ai/dsh-tool-pwsh'),
    import('@deepseek-ai/dsh-tool-fs'),
    optionalImport('@deepseek-ai/dsh-skill-filesystem'),
  ])
  return {
    defineTool: tools.defineTool,
    createScope: scope.createScope,
    FileSystem: fsMod.FileSystem,
    FsError: fsMod.FsError,
    SubprocessRuntime: subprocess.SubprocessRuntime,
    SubprocessExecutableNotFoundError: subprocess.SubprocessExecutableNotFoundError,
    BashLocal: bashLocal.default ?? bashLocal.LocalBashExecutor,
    PwshLocal: pwshLocal.default ?? pwshLocal.PwshLocalExecutor,
    ToolBash: toolBash,
    ToolPwsh: toolPwsh,
    ToolFs: toolFs,
    SkillFilesystem: skills,
  }
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export async function apply(ctx, config = {}) {
  const deps = await loadDeps()
  const dataDir = config.dataDir || path.join(dshHome(), 'storages', 'environments')
  const mountsDir = config.mountsDir || path.join(dshHome(), 'env-mounts')
  let logger
  try { logger = ctx.logger('environments') } catch {}
  const manager = new EnvironmentManager({ dataDir, autoDiscoverAdb: config.autoDiscoverAdb !== false, adb: config.adb || 'adb', logger })
  manager.load()
  ctx.effect(() => () => manager.dispose(), 'environments: manager')

  const titleOf = sessionId => sessionId.slice(0, 8)
  const mounting = installMounting(ctx, manager, deps)
  const borrowing = installBorrowing(ctx, manager, deps, { mountOf: agent => mounting.mountOf(agent), titleOf })
  installApi(ctx, manager, { mounting, borrowing, mountsDir })
}
