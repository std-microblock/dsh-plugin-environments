/**
 * Local declarations for the parts of the DSH host API this plugin touches.
 *
 * The published `@deepseek-ai/*` packages describe the plugin context through Cordis module
 * augmentation spread over dozens of packages (agents, sessions, system prompt, connection,
 * workspace registry, attachments, LLM). Pulling all of them in only for typing would couple
 * this plugin to every one of their internals, so the narrow structural surface used here is
 * declared once, in this module. Base classes and helpers with self-contained typings
 * (`FileSystem`, `SubprocessRuntime`, `defineTool`, `createScope`) come from their packages.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Disposer returned by registrations. */
export type Dispose = () => void

export interface Logger {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
}

/** The persisted session header of an agent. */
export interface SessionHeader {
  id?: string
  cwd: string
}

/** The routed request header (model selection) of an agent session. */
export interface RequestHeader {
  config?: { provider?: string; model?: string }
}

export interface AgentSession {
  id: string
  header: SessionHeader
  /** Present once the session has issued its first request. */
  requestHeader?(): RequestHeader | undefined
}

/** One running agent (a session or subagent). */
export interface Agent {
  ctx: PluginContext
  session: AgentSession
  options?: { provider?: string; model?: string }
}

export interface AgentRegistry {
  get(sessionId: string): Agent | undefined
}

/** A tool call as seen by `tools/result` listeners. */
export interface ToolResultExecution {
  agent?: Agent
  name: string
  arguments?: Record<string, unknown>
}

export interface ToolResultOutcome {
  isError: boolean
}

export interface ToolRestriction {
  deny?: string[]
  allow?: string[]
}

export interface ToolRuntime {
  register(definition: ToolDefinition): Dispose
  restrict(filter: ToolRestriction): Dispose
  schemas(scope?: object): ToolSchema[]
}

export interface SystemPromptSection {
  name: string
  order: number
  interpolate: boolean
  text: string
}

export interface SystemPrompt {
  getSectionOrder(name: string): number
  section(section: SystemPromptSection): Dispose
  variable(name: string, value: () => string): Dispose
}

export interface FetchRoute {
  path: string
  methods: string[]
  requestBody: 'buffered'
  fetch(request: Request): Promise<Response>
}

export interface HostConnection {
  fetch: { register(route: FetchRoute): Dispose }
}

export interface WorkspaceRegistry {
  create(path: string, title: string): Promise<{ id: string }>
  delete(id: string): Promise<void>
  get(id: string): { path: string } | undefined
}

export interface SavedImage {
  attachmentId: string | number
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: { width: number; height: number }
}

export interface AttachmentStore {
  saveImage(image: { data: Uint8Array; mediaType: string; name: string }): Promise<SavedImage>
}

export interface LlmRuntime {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: string[] }>
}

/** Optional services looked up with `ctx.get(name)`. */
export interface OptionalServices {
  agents: AgentRegistry
  workspaceRegistry: WorkspaceRegistry
  attachments: AttachmentStore
  llm: LlmRuntime
}

export interface AgentCreatedEvent {
  agent: Agent
}

/** A plugin installed into an isolated realm (`ctx.plugin`). */
export type PluginLike = object

/** The plugin context (a Cordis `Context` with the DSH services this plugin uses). */
export interface PluginContext {
  tools: ToolRuntime
  systemPrompt: SystemPrompt
  logger(name: string): Logger
  effect(fn: () => () => unknown, label?: string): unknown
  on(event: 'agent/created', listener: (event: AgentCreatedEvent) => unknown): Dispose
  on(event: 'tools/result', listener: (exec: ToolResultExecution, result: ToolResultOutcome) => unknown): Dispose
  get<K extends keyof OptionalServices>(name: K): OptionalServices[K] | undefined
  inject(deps: ['connection'], fn: (scope: PluginContext & { connection: HostConnection }) => unknown): unknown
  isolate(name: string): PluginContext
  plugin(plugin: PluginLike, config?: unknown): unknown
}

/** The calling agent of a tool execution (typed by `@deepseek-ai/dsh-agent`, declared locally here). */
export function agentOf(exec: { agent?: unknown }): Agent | undefined {
  return exec.agent as Agent | undefined
}

/** Session id of an agent (header id, else the session object id). */
export function sessionIdOf(agent: Agent): string {
  return agent.session.header.id ?? agent.session.id
}

/** Whether the agent's session has issued its first request (its mount can no longer change). */
export function sessionStarted(agent: Agent): boolean {
  try {
    return agent.session.requestHeader?.() !== undefined
  } catch {
    return false
  }
}

/** View a structurally typed plugin context as the Cordis context the DSH base classes expect. */
export function asCordisContext(ctx: PluginContext): Context {
  return ctx as unknown as Context
}

/** View a Cordis context handed to a service constructor as the plugin context surface. */
export function asPluginContext(ctx: Context): PluginContext {
  return ctx as unknown as PluginContext
}
