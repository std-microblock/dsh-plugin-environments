// The environment tools: one fixed set (env_exec, env_read_file, ..., env_screenshot, env_input)
// shared by every borrowed environment. Each call picks its environment with the `environment`
// argument, so borrowing, returning, taking the GUI or reconnecting never changes the tool list.
//
// They come in two groups: the headless tools (files, commands, processes, tunnels, Android apps
// and logs) usable on every held environment, and the GUI tools (screenshot, input, ui, windows,
// device) usable only on an environment whose GUI the session holds.
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { DefineToolFn } from '../../deps.ts'
import type { Environment } from '../../env/environment.ts'
import type { PluginContext } from '../../host-api.ts'
import { addAndroidGuiTools, addAndroidTools } from './android-tools.ts'
import {
  createEnvToolContext,
  TOOL_PREFIX,
  type TargetResolver,
  type ToolRequirement,
  type WorkspaceResolver,
} from './context.ts'
import { addFileTools } from './file-tools.ts'
import { addProcessTools } from './process-tools.ts'
import { addScreenTools } from './screen-tools.ts'
import { addTunnelTool } from './tunnel-tool.ts'
import { addUiTools } from './ui-tools.ts'
import { addWindowTools } from './windows-tools.ts'

export interface EnvTools {
  tools: ToolDefinition[]
  /** Names of the tools usable on an environment (GUI tools only when `gui`). */
  namesFor(env: Environment, opts: { headless: boolean; gui: boolean }): string[]
}

export interface EnvToolsOptions {
  /** Plugin context (attachments, llm). */
  ctx: PluginContext
  defineTool: DefineToolFn
  /** Resolves a call's `environment` argument to a held environment. */
  resolve: TargetResolver
  /** The session's own workspace (for APK sources). */
  workspaceOf: WorkspaceResolver
}

/** Build the environment tool definitions. */
export function envTools({ ctx, defineTool, resolve, workspaceOf }: EnvToolsOptions): EnvTools {
  const tools: ToolDefinition[] = []
  const requirements: ToolRequirement[] = []
  const t = createEnvToolContext(ctx, defineTool, resolve, workspaceOf, tools, requirements)
  addFileTools(t)
  addProcessTools(t)
  addTunnelTool(t)
  addAndroidTools(t)
  addScreenTools(t)
  addUiTools(t)
  addWindowTools(t)
  addAndroidGuiTools(t)
  return {
    tools,
    namesFor: (env, { headless, gui }) =>
      requirements
        .filter(r => (r.gui ? gui : headless) && (r.supports?.(env) ?? true))
        .map(r => `${TOOL_PREFIX}${r.name}`),
  }
}

export { ManagedProcess } from './process-tools.ts'
export type { LeaseTarget, ToolRequirement, WorkspaceLocation, WorkspaceResolver } from './context.ts'
