// A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0 on stdin/stdout, as the Model
// Context Protocol specifies for the stdio transport. Only what the tool table needs is
// implemented — initialize, ping, tools/list, tools/call and cancellation; resources and prompts
// are answered as empty so clients that probe them are not left hanging.
//
// stdout belongs to the protocol: everything else (startup banner, warnings) goes to stderr.
import type { McpTool } from './tools.ts'

/** Protocol revisions this server can speak, newest first. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number]

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: unknown
}

interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

/** A request id (`null` for unparseable input); notifications carry none. */
type RequestId = string | number | null

export interface McpServerOptions {
  tools: McpTool[]
  version: string
  name?: string | undefined
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  log: (message: string) => void
  /** Called once the client identified itself in `initialize`. */
  onClient?: ((name: string) => void) | undefined
}

/** JSON-RPC error codes used here. */
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

const INSTRUCTIONS = [
  'These tools operate other devices and machines (this host, dsh-env-server hosts, SSH hosts, Android devices over adb, Windows test accounts) that a human configured in DeepSeek Harness.',
  'Call env_list first: it shows what may be borrowed and its live status. Borrow with env_borrow, then use the env_* tools with the alias it returned as their `environment` argument (it may be omitted while only one borrowed environment offers that tool). Screen tools (env_screenshot, env_input, env_ui, env_windows, env_device) require the GUI: borrow with gui: true.',
  'Return the environment with env_return when done. Copy files with env_transfer; a location is "alias:/path" for a borrowed environment or a plain path for the workspace this server was started in.',
].join(' ')

export class McpStdioServer {
  private readonly tools: McpTool[]
  private readonly version: string
  private readonly name: string
  private readonly stdin: NodeJS.ReadableStream
  private readonly stdout: NodeJS.WritableStream
  private readonly log: (message: string) => void
  private readonly onClient: ((name: string) => void) | undefined
  private readonly controllers = new Map<RequestId, AbortController>()
  private readonly pending = new Set<Promise<void>>()
  private clientName: string | undefined = undefined
  private closed = false

  constructor({ tools, version, name, stdin, stdout, log, onClient }: McpServerOptions) {
    this.tools = tools
    this.version = version
    this.name = name ?? 'dsh-environments'
    this.stdin = stdin
    this.stdout = stdout
    this.log = log
    this.onClient = onClient
  }

  /** Client name reported by `initialize` (for logs and the lease list). */
  get initializedClient(): string | undefined {
    return this.clientName
  }

  /** Serve until stdin ends, then wait for in-flight calls to settle. */
  async run(): Promise<void> {
    const input = this.stdin
    input.setEncoding?.('utf8')
    await new Promise<void>(resolve => {
      let buffer = ''
      const onData = (chunk: Buffer | string) => {
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
          const line = buffer.slice(0, i).replace(/\r$/, '')
          buffer = buffer.slice(i + 1)
          if (line.trim()) this.accept(line)
        }
      }
      const onEnd = () => {
        if (buffer.trim()) this.accept(buffer)
        buffer = ''
        resolve()
      }
      input.on('data', onData as (chunk: unknown) => void)
      input.on('end', onEnd)
      input.on('close', onEnd)
      input.on('error', (e: unknown) => {
        this.log(`stdin error: ${String(e)}`)
        onEnd()
      })
    })
    this.closed = true
    // Give in-flight calls a moment to finish; abandoning them is worse than a short delay.
    await Promise.allSettled([...this.pending])
  }

  /** Queue one inbound line for handling. */
  private accept(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch (e) {
      this.send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: `invalid JSON: ${String(e)}` } })
      return
    }
    if (Array.isArray(message)) {
      // JSON-RPC batching is gone from the MCP revisions this server speaks.
      this.send({
        jsonrpc: '2.0',
        id: null,
        error: { code: INVALID_REQUEST, message: 'batching is not supported' },
      })
      return
    }
    if (typeof message !== 'object' || message === null) {
      this.send({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'expected an object' } })
      return
    }
    const request = message as JsonRpcRequest
    if (typeof request.method !== 'string') {
      // A response (this server sends no requests) or garbage: nothing to do.
      return
    }
    if (request.id === undefined) {
      this.notify(request)
      return
    }
    const job = this.serve(request).catch((e: unknown) => {
      this.send({
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: INTERNAL_ERROR, message: String(e) },
      })
    })
    this.pending.add(job)
    void job.finally(() => this.pending.delete(job))
  }

  /** Handle a notification (no reply). */
  private notify(request: JsonRpcRequest): void {
    if (request.method === 'notifications/cancelled') {
      const params = request.params as { requestId?: string | number } | undefined
      const id = params?.requestId
      if (id !== undefined) this.controllers.get(id)?.abort()
      return
    }
    // notifications/initialized and anything else needs no action.
  }

  private async serve(request: JsonRpcRequest): Promise<void> {
    const id = request.id ?? null
    try {
      const result = await this.dispatch(request)
      this.send({ jsonrpc: '2.0', id, result })
    } catch (e) {
      const error = e as { code?: unknown; message?: unknown }
      this.send({
        jsonrpc: '2.0',
        id,
        error: {
          code: typeof error.code === 'number' ? error.code : INTERNAL_ERROR,
          message: typeof error.message === 'string' ? error.message : String(e),
        } satisfies JsonRpcError,
      })
    } finally {
      if (request.id !== undefined) this.controllers.delete(request.id)
    }
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    switch (request.method) {
      case 'initialize':
        return this.initialize(request.params)
      case 'ping':
        return {}
      case 'tools/list':
        return {
          tools: this.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        }
      case 'tools/call':
        return await this.call(request)
      case 'resources/list':
        return { resources: [] }
      case 'resources/templates/list':
        return { resourceTemplates: [] }
      case 'prompts/list':
        return { prompts: [] }
      case 'logging/setLevel':
        return {}
      default:
        throw Object.assign(new Error(`unknown method ${request.method}`), { code: METHOD_NOT_FOUND })
    }
  }

  private initialize(params: unknown): unknown {
    const p = (params ?? {}) as { protocolVersion?: unknown; clientInfo?: { name?: unknown; version?: unknown } }
    const requested = typeof p.protocolVersion === 'string' ? p.protocolVersion : undefined
    const protocolVersion =
      requested && (PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : PROTOCOL_VERSIONS[0]
    const name = typeof p.clientInfo?.name === 'string' ? p.clientInfo.name : 'unknown client'
    const version = typeof p.clientInfo?.version === 'string' ? ` ${p.clientInfo.version}` : ''
    this.clientName = name
    try {
      this.onClient?.(name)
    } catch {
      // A title is cosmetic: never fail initialize over it.
    }
    this.log(`initialize from ${name}${version} (protocol ${protocolVersion})`)
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: this.name,
        title: 'DeepSeek Harness environments',
        version: this.version,
      },
      instructions: INSTRUCTIONS,
    }
  }

  private async call(request: JsonRpcRequest): Promise<unknown> {
    const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown }
    const name = typeof params.name === 'string' ? params.name : ''
    const tool = this.tools.find(t => t.name === name)
    if (!tool) throw Object.assign(new Error(`unknown tool ${JSON.stringify(name)}`), { code: INVALID_PARAMS })
    const args =
      typeof params.arguments === 'object' && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {}
    const controller = new AbortController()
    if (request.id !== undefined) this.controllers.set(request.id, controller)
    if (this.closed) throw new Error('the MCP connection is closing')
    const environment = args['environment']
    this.log(`tools/call ${name}${typeof environment === 'string' ? ` (${environment})` : ''}`)
    return await tool.call(args, controller.signal)
  }

  private send(message: unknown): void {
    if ((this.stdout as { destroyed?: boolean }).destroyed === true) return
    try {
      this.stdout.write(`${JSON.stringify(message)}\n`)
    } catch (e) {
      this.log(`cannot write to stdout: ${String(e)}`)
    }
  }
}
