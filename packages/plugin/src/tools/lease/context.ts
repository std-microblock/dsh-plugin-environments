// Shared context of the tools contributed for one lease.
import type { DefineToolOptions, ParameterSchemaSpec, ToolDefinition, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { DefineToolFn } from '../../deps.ts'
import type { Environment } from '../../env/environment.ts'
import type { PluginContext } from '../../host-api.ts'
import type { Lease } from '../../manager/lease.ts'

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

/** Adds one tool, prefixing its name with the lease alias. */
export type AddTool = <const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  def: DefineToolOptions<S, O>,
) => void

export interface LeaseToolContext {
  ctx: PluginContext
  lease: Lease
  env: Environment
  /** Lease alias (tool-name prefix). */
  alias: string
  /** Display name used in tool descriptions: "<env name> (<alias>)". */
  label: string
  /** The environment's working directory. */
  cwd: string | undefined
  /** Resolve a tool path argument against the environment cwd. */
  abs: (p: string | undefined) => string
  add: AddTool
  workspaceOf: WorkspaceResolver
}

export function createLeaseToolContext(
  ctx: PluginContext,
  defineTool: DefineToolFn,
  lease: Lease,
  workspaceOf: WorkspaceResolver,
  tools: ToolDefinition[],
  aliasOverride?: string,
): LeaseToolContext {
  const env = lease.env
  const alias = aliasOverride ?? lease.alias
  const cwd = env.info?.cwd
  return {
    ctx,
    lease,
    env,
    alias,
    label: `${lease.def.name} (${alias})`,
    cwd,
    abs: p => env.resolvePath(p ?? '.', cwd),
    add: def => {
      // Erase the per-tool generics: `defineTool` already validated `def` at the call site.
      const options = def as unknown as DefineToolOptions<ParameterSchemaSpec, ValueSchemaSpec>
      tools.push(defineTool({ ...options, name: `${alias}__${def.name}` }))
    },
    workspaceOf,
  }
}
