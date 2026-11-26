// The MCP tool table: env_list / env_borrow / env_return / env_transfer, plus the fixed set of
// env_* tools the DSH plugin registers for a session (env_exec, env_read_file, env_screenshot, ...).
//
// The env_* tools are the very same definitions the plugin registers with DSH: `envTools` builds
// them from the tool-schema DSL, and here `defineTool` is replaced by an identity function, so the
// MCP surface cannot drift from the agent's. Only the borrowing tools are re-implemented, because
// the plugin's versions are tied to agent sessions, mounts and prompt contexts that do not exist
// in a standalone MCP process.
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { EnvError, errorMessage } from '@dsh-environments/protocol'
import type { DefineToolFn } from '../deps.ts'
import { envTools } from '../tools/lease/index.ts'
import { parametersToJsonSchema, validateArgs, type JsonSchemaNode } from './json-schema.ts'
import type { McpExec, McpSession } from './session.ts'

/** One MCP content block (`image` carries base64, as the MCP spec requires). */
export type McpContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface McpToolResult {
  content: McpContentBlock[]
  isError?: boolean
}

/** A tool as the MCP client sees it, with the call bound to this connection's session. */
export interface McpTool {
  name: string
  description: string
  inputSchema: JsonSchemaNode
  call(args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult>
}

/** A tool body in the shape the shared helpers produce before DSH compiles it. */
interface RawTool {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  output: { render(args: unknown, value: unknown): readonly unknown[] }
  timeoutMs?: number | undefined
  execute(args: Record<string, unknown>, exec: McpExec): Promise<unknown>
}

/** `defineTool` stand-in: the tool bodies only need their options object back. */
const identityDefineTool = ((options: unknown) => options) as unknown as DefineToolFn

function text(value: string): McpToolResult {
  return { content: [{ type: 'text', text: value }] }
}

function failure(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** A string argument (JSON Schema validation already rejected mistyped values). */
function str(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value : ''
}

/** Turn the shared tool output (text and image blocks) into MCP content blocks. */
function renderResult(session: McpSession, tool: RawTool, args: unknown, value: unknown): McpToolResult {
  const blocks: McpContentBlock[] = []
  for (const raw of tool.output.render(args, value)) {
    const block = raw as { type?: unknown; text?: unknown; attachment?: { attachmentId?: unknown } }
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image' && block.attachment && typeof block.attachment.attachmentId === 'string') {
      const image = session.attachments.take(block.attachment.attachmentId)
      if (image) blocks.push({ type: 'image', data: image.data.toString('base64'), mimeType: image.mediaType })
    }
  }
  // Images are inlined above; nothing needs to stay behind per call.
  session.attachments.clear()
  return blocks.length > 0 ? { content: blocks } : text('(no result)')
}

/** Bind one tool body to this MCP connection. */
function toMcpTool(session: McpSession, tool: RawTool): McpTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: parametersToJsonSchema(tool.parameters),
    async call(args, signal) {
      const violations = validateArgs(tool.parameters, args)
      if (violations.length > 0) return failure(`invalid arguments: ${violations.join('; ')}`)
      const timeout = tool.timeoutMs ? AbortSignal.timeout(tool.timeoutMs) : undefined
      const combined = signal && timeout ? AbortSignal.any([signal, timeout]) : (signal ?? timeout)
      try {
        const value = await tool.execute(args, { agent: session.agent, signal: combined })
        return renderResult(session, tool, args, value)
      } catch (e) {
        const code = e instanceof EnvError ? `${e.code}: ` : ''
        return failure(`error: ${code}${errorMessage(e)}`)
      }
    },
  }
}

/** The borrowing tools: list, borrow (or upgrade to GUI), return, transfer. */
function borrowingTools(session: McpSession): RawTool[] {
  const list: RawTool = {
    name: 'env_list',
    description:
      'List the environments (devices/machines) this MCP connection may borrow, their live status (who holds them, including the GUI), and the ones it currently holds.',
    parameters: {},
    output: { render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] },
    async execute() {
      return await session.listText()
    },
  }

  const borrow: RawTool = {
    name: 'env_borrow',
    description: [
      'Borrow an environment (e.g. an Android device, a test machine, a Windows test account). It is then used through the env_* tools (env_exec, env_read_file, env_write_file, env_process_start, env_tunnel, env_install_apk, ...), passing the alias this returns as their `environment` argument. Return it with env_return when done.',
      'A lease is headless by default: files, commands, processes, tunnels and non-screen tools (install_apk, app, logcat). Headless leases of other sessions may run at the same time, unless the environment is exclusive.',
      'Pass gui: true only when you need to see or drive the screen: env_screenshot, env_input, env_ui, env_windows and env_device (as the environment supports) then act on it. Only one session at a time holds the GUI of an environment; with wait: true you queue for it.',
      'Calling env_borrow again on an environment you already hold with gui: true upgrades it to GUI; gui: false gives the GUI back but keeps the lease.',
      'A borrowed environment whose connection drops stays borrowed and reconnects by itself; do not borrow it again.',
    ].join(' '),
    parameters: {
      environment: { type: 'string', required: true, description: 'Environment id from env_list.' },
      gui: {
        type: 'boolean',
        description:
          'Also take the GUI (screen tools). Default false. On an environment you already hold: true upgrades, false downgrades, omitted keeps the mode.',
      },
      wait: {
        type: 'boolean',
        description: 'If it (or its GUI) is busy, wait in line instead of failing immediately (default false).',
      },
      timeout_seconds: { type: 'number', description: 'Maximum time to wait when wait=true (default 600).' },
      reason: { type: 'string', description: 'Short note shown to other sessions and the user, e.g. "e2e tests".' },
    },
    output: { render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] },
    timeoutMs: 24 * 60 * 60 * 1000,
    async execute(args, exec) {
      const entry = await session.borrow(str(args, 'environment'), {
        gui: args['gui'] === true,
        wait: args['wait'] === true,
        timeoutMs: Math.max(1, Math.min(24 * 3600, Number(args['timeout_seconds'] ?? 600))) * 1000,
        signal: exec.signal,
        reason: typeof args['reason'] === 'string' ? args['reason'] : undefined,
      })
      const def = entry.lease.def
      const env = entry.lease.env
      const info = env.info
      const state = `${info?.os ?? '?'}${info?.version ? `, ${info.version}` : ''}; user ${info?.user || '?'}; cwd ${info?.cwd || '?'}`
      return `Borrowed ${def.name} as "${entry.alias}" (${entry.gui ? 'GUI' : 'headless'}; ${state}). Use the env_* tools with environment: "${entry.alias}"; call env_return when you are done so others can use it.`
    },
  }

  const giveBack: RawTool = {
    name: 'env_return',
    description:
      'Return a borrowed environment. Every process and tunnel opened through it is closed. With gui_only: true only the GUI is given back (the screen tools stop acting on it, the lease stays headless).',
    parameters: {
      environment: {
        type: 'string',
        required: true,
        description: 'Alias or id of the borrowed environment, or "all".',
      },
      gui_only: { type: 'boolean', description: 'Only give back the GUI and keep the headless lease (default false).' },
    },
    output: { render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      const out = await session.release(str(args, 'environment'), args['gui_only'] === true)
      return `${out.join('; ')}.`.replace(/^./, c => c.toUpperCase())
    },
  }

  const transfer: RawTool = {
    name: 'env_transfer',
    description:
      'Copy a file or directory between this MCP server\'s workspace and borrowed environments, or between two borrowed environments. Locations are "alias:/path" for a borrowed environment, or a plain path (or "workspace:path") for the workspace (env_list shows its directory).',
    parameters: {
      source: {
        type: 'string',
        required: true,
        description: 'Source location, e.g. "build/app.apk" or "pixel:/sdcard/Download/log.txt".',
      },
      destination: {
        type: 'string',
        required: true,
        description: 'Destination location (full target path, not just the directory).',
      },
      overwrite: { type: 'boolean', description: 'Replace existing files.' },
    },
    output: { render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] },
    timeoutMs: 60 * 60 * 1000,
    async execute(args, exec) {
      return await session.transfer(
        {
          source: str(args, 'source'),
          destination: str(args, 'destination'),
          overwrite: args['overwrite'] === true,
        },
        exec.signal,
      )
    },
  }

  return [list, borrow, giveBack, transfer]
}

/**
 * Build the tool table of one MCP connection: the borrowing tools followed by the shared env_*
 * tools. Screen tools stay listed like in DSH and explain what to do when the GUI is not held.
 */
export function buildMcpTools(session: McpSession): McpTool[] {
  const shared = envTools({
    ctx: session.ctx,
    defineTool: identityDefineTool,
    resolve: (exec, environment, requirement) => session.resolve(exec, environment, requirement),
    workspaceOf: (exec, sourceAlias, filePath) => session.workspaceOf(exec, sourceAlias, filePath),
  })
  const raw: RawTool[] = [...borrowingTools(session), ...(shared.tools as unknown as RawTool[])]
  const seen = new Set<string>()
  const tools: McpTool[] = []
  for (const tool of raw) {
    if (seen.has(tool.name)) throw new Error(`duplicate MCP tool name ${tool.name}`)
    seen.add(tool.name)
    tools.push(toMcpTool(session, tool))
  }
  return tools
}
