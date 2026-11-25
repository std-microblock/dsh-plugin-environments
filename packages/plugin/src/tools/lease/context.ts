// Shared context of the environment tools (env_exec, env_read_file, env_screenshot, ...).
//
// The tools are registered once, with fixed names and schemas, so borrowing, returning or
// reconnecting an environment never changes a session's tool list (and its prompt cache). Each
// call names its environment with the `environment` argument — the alias of a borrowed
// environment — and resolves it at call time to the lease's current connection.
import type { DefineToolOptions, ParameterSchemaSpec, ToolDefinition, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { DefineToolFn } from '../../deps.ts'
import type { Environment } from '../../env/environment.ts'
import type { PluginContext } from '../../host-api.ts'
import type { Lease } from '../../manager/lease.ts'
import type { ManagedProcess } from './process-tools.ts'
import type { ScreenSession } from '../screen/session.ts'

/** A location a session can read files from: its workspace, or another borrowed environment. */
export interface WorkspaceLocation {
  env: Environment
  cwd: string | undefined
  /** Host path of the file when the workspace is the harness host itself. */
  hostPath?: string | undefined
}

/** Resolve the session's own workspace (or a borrowed alias) for a tool call. */
export type WorkspaceResolver = (
  exec: { agent?: unknown },
  sourceAlias?: string,
  filePath?: string,
) => Promise<WorkspaceLocation>

/** A held environment, resolved for one tool call. */
export interface LeaseTarget {
  lease: Lease
  /** The lease's current (connected) environment. */
  env: Environment
  /** The alias the session holds it as (the `environment` argument). */
  alias: string
  /** "<env name> (<alias>)", for messages. */
  label: string
  /** The environment's working directory. */
  cwd: string | undefined
  /** Resolve a tool path argument against the environment cwd. */
  abs: (p: string | undefined) => string
  /** Screen state (frame, elements) of this connection. */
  screen: ScreenSession
  /** Processes started with env_process_start through this entry. */
  processes: Map<string, ManagedProcess>
  nextProcessId(): string
}

/** What a tool needs from the environment it runs on. */
export interface ToolRequirement {
  /** Tool name without the `env_` prefix. */
  name: string
  /** A screen tool: needs the GUI of the environment. */
  gui: boolean
  /** Whether the environment offers the tool (default: every environment). */
  supports?: ((env: Environment) => boolean) | undefined
}

/** Resolves the `environment` argument of a call into a held environment. */
export type TargetResolver = (
  exec: { agent?: unknown; signal?: AbortSignal | undefined },
  environment: string | undefined,
  requirement: ToolRequirement,
) => Promise<LeaseTarget>

/** Adds one tool, prefixing its name with `env_`. */
export type AddTool = <const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  def: DefineToolOptions<S, O>,
) => void

export interface EnvToolContext {
  ctx: PluginContext
  add: AddTool
  /** Declare a tool's requirement; returns the resolver its `execute` calls first. */
  use: (
    requirement: ToolRequirement,
  ) => (
    exec: { agent?: unknown; signal?: AbortSignal | undefined },
    environment: string | undefined,
  ) => Promise<LeaseTarget>
  workspaceOf: WorkspaceResolver
}

/** The `environment` parameter every environment tool takes. */
export const ENV_PARAM = {
  environment: {
    type: 'string',
    description:
      'Alias of the borrowed environment to act on (as env_borrow reported it). May be omitted while this session holds only one environment that offers the tool.',
  },
} as const

/** The `environment` parameter of the screen tools. */
export const GUI_ENV_PARAM = {
  environment: {
    type: 'string',
    description:
      'Alias of the environment whose screen to use; this session must hold its GUI (env_borrow with gui: true). May be omitted while it holds only one GUI.',
  },
} as const

export const TOOL_PREFIX = 'env_'

export function createEnvToolContext(
  ctx: PluginContext,
  defineTool: DefineToolFn,
  resolve: TargetResolver,
  workspaceOf: WorkspaceResolver,
  tools: ToolDefinition[],
  requirements: ToolRequirement[],
): EnvToolContext {
  return {
    ctx,
    add: def => {
      // Erase the per-tool generics: `defineTool` already validated `def` at the call site.
      const options = def as unknown as DefineToolOptions<ParameterSchemaSpec, ValueSchemaSpec>
      tools.push(defineTool({ ...options, name: `${TOOL_PREFIX}${def.name}` }))
    },
    use: requirement => {
      requirements.push(requirement)
      return (exec, environment) => resolve(exec, environment, requirement)
    },
    workspaceOf,
  }
}
