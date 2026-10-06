// Harness modules this plugin builds on, resolved lazily from the running DSH installation.
import type { createScope as CreateScope } from '@deepseek-ai/dsh-scope'
import type { defineTool as DefineTool } from '@deepseek-ai/dsh-tools'
import type { FileSystem as FileSystemBase, FsError as FsErrorClass } from '@deepseek-ai/dsh-fs'
import type {
  SubprocessExecutableNotFoundError as NotFoundError,
  SubprocessRuntime as SubprocessRuntimeBase,
} from '@deepseek-ai/dsh-subprocess'
import { asCordisContext, type PluginContext, type PluginLike } from './host-api.ts'

/** A registration scope bound to one agent; disposing it removes everything registered through it. */
export interface HarnessScope {
  ctx: PluginContext
  dispose(): Promise<void>
}

export type DefineToolFn = typeof DefineTool

export interface HarnessDeps {
  defineTool: DefineToolFn
  createScope(ctx: PluginContext, key: object): HarnessScope
  FileSystem: typeof FileSystemBase
  FsError: typeof FsErrorClass
  SubprocessRuntime: typeof SubprocessRuntimeBase
  SubprocessExecutableNotFoundError: typeof NotFoundError
  BashLocal: PluginLike
  PwshLocal: PluginLike
  ToolBash: PluginLike
  ToolPwsh: PluginLike
  ToolFs: PluginLike
  SkillFilesystem: PluginLike | undefined
}

type ModuleNamespace = Record<string, unknown>

/** Import a module only known at runtime (no bundled typings), as an opaque namespace. */
async function importRuntime(spec: string): Promise<ModuleNamespace> {
  return (await import(spec)) as ModuleNamespace
}

async function optionalImport(spec: string): Promise<ModuleNamespace | undefined> {
  try {
    return await importRuntime(spec)
  } catch {
    return undefined
  }
}

/** The plugin class a harness module exports (default export, else the named one). */
function pluginExport(mod: ModuleNamespace, named: string): PluginLike {
  // Not validated here: a missing export surfaces when the plugin is installed into a realm.
  return (mod['default'] ?? mod[named]) as PluginLike
}

/** Load the harness modules this plugin builds on (resolved from the running installation). */
export async function loadDeps(): Promise<HarnessDeps> {
  const [tools, scope, fsMod, subprocess, bashLocal, pwshLocal, toolBash, toolPwsh, toolFs, skills] = await Promise.all(
    [
      import('@deepseek-ai/dsh-tools'),
      import('@deepseek-ai/dsh-scope'),
      import('@deepseek-ai/dsh-fs'),
      import('@deepseek-ai/dsh-subprocess'),
      importRuntime('@deepseek-ai/dsh-bash-local'),
      importRuntime('@deepseek-ai/dsh-pwsh-local'),
      importRuntime('@deepseek-ai/dsh-tool-bash'),
      importRuntime('@deepseek-ai/dsh-tool-pwsh'),
      importRuntime('@deepseek-ai/dsh-tool-fs'),
      optionalImport('@deepseek-ai/dsh-skill-filesystem'),
    ],
  )
  const createScope: typeof CreateScope = scope.createScope
  return {
    defineTool: tools.defineTool,
    createScope: (ctx, key) => createScope(asCordisContext(ctx), key) as unknown as HarnessScope,
    FileSystem: fsMod.FileSystem,
    FsError: fsMod.FsError,
    SubprocessRuntime: subprocess.SubprocessRuntime,
    SubprocessExecutableNotFoundError: subprocess.SubprocessExecutableNotFoundError,
    BashLocal: pluginExport(bashLocal, 'LocalBashExecutor'),
    PwshLocal: pluginExport(pwshLocal, 'PwshLocalExecutor'),
    // Tool plugins are the module namespaces themselves (name/apply exports).
    ToolBash: toolBash,
    ToolPwsh: toolPwsh,
    ToolFs: toolFs,
    SkillFilesystem: skills,
  }
}
