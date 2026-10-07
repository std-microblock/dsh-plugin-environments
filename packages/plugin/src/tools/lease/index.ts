// Tools contributed for one borrowed environment. Every tool name carries the lease alias prefix.
//
// They come in two sets: the headless set (files, commands, processes, tunnels, Android apps and
// logs) available with every lease, and the GUI set (screenshot, input, ui, windows, device)
// registered only while the lease holds the environment's GUI.
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { DefineToolFn } from '../../deps.ts'
import { AdbEnvironment } from '../../env/adb/adb-env.ts'
import type { PluginContext } from '../../host-api.ts'
import type { Lease } from '../../manager/lease.ts'
import { addAndroidGuiTools, addAndroidTools } from './android-tools.ts'
import { createLeaseToolContext, type WorkspaceResolver } from './context.ts'
import { addFileTools } from './file-tools.ts'
import { addProcessTools, type ManagedProcess } from './process-tools.ts'
import { addScreenTools } from './screen-tools.ts'
import { addTunnelTool } from './tunnel-tool.ts'
import { addUiTools } from './ui-tools.ts'
import { addWindowTools } from './windows-tools.ts'
import { ScreenSession } from '../screen/session.ts'

export interface LeaseTools {
  /** Tools of every lease. */
  headless: ToolDefinition[]
  /** Screen-driving tools, for GUI leases only (empty when the environment has no screen). */
  gui: ToolDefinition[]
  /** Kill every process started through the tools. */
  dispose(): Promise<void>
  processes: Map<string, ManagedProcess>
}

export interface LeaseToolsOptions {
  /** Plugin context (attachments, llm). */
  ctx: PluginContext
  defineTool: DefineToolFn
  lease: Lease
  /** Tool-name prefix (default: the lease alias). */
  alias?: string | undefined
  /** The session's own workspace (for APK sources). */
  workspaceOf: WorkspaceResolver
}

/** Build the tool definitions for a lease, according to the environment's capabilities. */
export function leaseTools({ ctx, defineTool, lease, alias, workspaceOf }: LeaseToolsOptions): LeaseTools {
  const headless: ToolDefinition[] = []
  const gui: ToolDefinition[] = []
  const t = createLeaseToolContext(ctx, defineTool, lease, workspaceOf, headless, alias)
  addFileTools(t)
  const processes = addProcessTools(t)
  addTunnelTool(t)
  if (t.env instanceof AdbEnvironment) addAndroidTools(t, t.env)

  const g = createLeaseToolContext(ctx, defineTool, lease, workspaceOf, gui, alias)
  const screen = new ScreenSession(g.env)
  addScreenTools(g, screen)
  addUiTools(g, screen)
  addWindowTools(g, screen)
  if (g.env instanceof AdbEnvironment) addAndroidGuiTools(g, g.env)

  const dispose = async () => {
    for (const mp of processes.values()) await mp.proc.kill().catch(() => {})
    processes.clear()
  }
  return { headless, gui, dispose, processes }
}

export type { WorkspaceLocation, WorkspaceResolver } from './context.ts'
