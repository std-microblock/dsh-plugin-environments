// Tools contributed for one borrowed environment. Every tool name carries the lease alias prefix.
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { DefineToolFn } from '../../deps.ts'
import { AdbEnvironment } from '../../env/adb/adb-env.ts'
import type { PluginContext } from '../../host-api.ts'
import type { Lease } from '../../manager/lease.ts'
import { addAndroidTools } from './android-tools.ts'
import { createLeaseToolContext, type WorkspaceResolver } from './context.ts'
import { addFileTools } from './file-tools.ts'
import { addProcessTools, type ManagedProcess } from './process-tools.ts'
import { addScreenTools } from './screen-tools.ts'
import { addTunnelTool } from './tunnel-tool.ts'
import { addUiTools } from './ui-tools.ts'
import { addWindowTools } from './windows-tools.ts'
import { ScreenSession } from '../screen/session.ts'

export interface LeaseTools {
  tools: ToolDefinition[]
  /** Kill every process started through the tools. */
  dispose(): Promise<void>
  processes: Map<string, ManagedProcess>
}

export interface LeaseToolsOptions {
  /** Plugin context (attachments, llm). */
  ctx: PluginContext
  defineTool: DefineToolFn
  lease: Lease
  /** The session's own workspace (for APK sources). */
  workspaceOf: WorkspaceResolver
}

/** Build the tool definitions for a lease, according to the environment's capabilities. */
export function leaseTools({ ctx, defineTool, lease, workspaceOf }: LeaseToolsOptions): LeaseTools {
  const tools: ToolDefinition[] = []
  const t = createLeaseToolContext(ctx, defineTool, lease, workspaceOf, tools)
  addFileTools(t)
  const processes = addProcessTools(t)
  addTunnelTool(t)
  const screen = new ScreenSession(t.env)
  addScreenTools(t, screen)
  addUiTools(t, screen)
  addWindowTools(t, screen)
  if (t.env instanceof AdbEnvironment) addAndroidTools(t, t.env)

  const dispose = async () => {
    for (const mp of processes.values()) await mp.proc.kill().catch(() => {})
    processes.clear()
  }
  return { tools, dispose, processes }
}

export type { WorkspaceLocation, WorkspaceResolver } from './context.ts'
