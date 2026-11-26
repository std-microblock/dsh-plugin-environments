// The MCP server: schema projection, argument validation, and a full stdio session (handshake,
// tools/list, borrowing, file/shell access through env_* tools, returning).
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parametersToJsonSchema, validateArgs } from '../src/mcp/json-schema.ts'
import { buildMcpTools } from '../src/mcp/tools.ts'
import { EnvironmentManager } from '../src/manager/manager.ts'
import { McpSession } from '../src/mcp/session.ts'
import { needsServer } from './helpers.ts'

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp', 'main.ts')

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

/** Minimal MCP stdio client for the tests. */
class McpClient {
  private readonly proc: ChildProcessWithoutNullStreams
  private buffer = ''
  private seq = 0
  private readonly waiting = new Map<number, (msg: JsonRpcResponse) => void>()
  readonly stderr: string[] = []

  private constructor(proc: ChildProcessWithoutNullStreams) {
    this.proc = proc
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      for (let i = this.buffer.indexOf('\n'); i >= 0; i = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, i).trim()
        this.buffer = this.buffer.slice(i + 1)
        if (!line) continue
        const message = JSON.parse(line) as JsonRpcResponse
        const resolve = typeof message.id === 'number' ? this.waiting.get(message.id) : undefined
        if (resolve && typeof message.id === 'number') {
          this.waiting.delete(message.id)
          resolve(message)
        }
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim()) this.stderr.push(line)
    })
  }

  static start(dataDir: string, args: string[] = []): McpClient {
    const proc = spawn(process.execPath, [ENTRY, '--data-dir', dataDir, '--no-adb-discovery', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return new McpClient(proc)
  }

  request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`no reply to ${method}; stderr: ${this.stderr.join(' | ')}`))
      }, 60000)
      this.waiting.set(id, message => {
        clearTimeout(timer)
        resolve(message)
      })
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  notify(method: string, params?: unknown): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  /** Result of a request that must succeed. */
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const response = await this.request(method, params)
    if (response.error) throw new Error(`${method}: ${response.error.message}`)
    return response.result as T
  }

  /** Text of a tools/call result. */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const result = await this.call<{ content: { type: string; text?: string }[]; isError?: boolean }>('tools/call', {
      name,
      arguments: args,
    })
    return { text: result.content.map(c => c.text ?? '').join('\n'), isError: result.isError === true }
  }

  async close(): Promise<void> {
    this.proc.stdin.end()
    await new Promise<void>(resolve => {
      if (this.proc.exitCode !== null) return resolve()
      this.proc.once('exit', () => resolve())
      setTimeout(() => {
        this.proc.kill()
        resolve()
      }, 10000).unref()
    })
  }
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-env-mcp-test-'))

test('tool schemas are valid JSON Schema with required fields', () => {
  const dataDir = tmpDir()
  const manager = new EnvironmentManager({ dataDir, autoDiscoverAdb: false })
  manager.load()
  const session = new McpSession({ manager, workspaceDir: dataDir })
  const tools = buildMcpTools(session)
  try {
    const names = tools.map(t => t.name)
    for (const expected of ['env_list', 'env_borrow', 'env_return', 'env_transfer', 'env_exec', 'env_read_file'])
      assert.ok(names.includes(expected), `missing ${expected}`)
    assert.equal(new Set(names).size, names.length, 'tool names must be unique')

    const exec = tools.find(t => t.name === 'env_exec')
    assert.ok(exec)
    assert.equal(exec.inputSchema.type, 'object')
    assert.deepEqual(exec.inputSchema.required, ['command'])
    assert.equal(exec.inputSchema.properties?.['command']?.type, 'string')
    assert.deepEqual(exec.inputSchema.properties?.['environment']?.type, 'string')

    // Nested objects and arrays survive the projection.
    const input = tools.find(t => t.name === 'env_input')
    assert.ok(input)
    const actions = input.inputSchema.properties?.['actions']
    assert.equal(actions?.type, 'array')
    assert.equal(actions?.items?.type, 'object')
    assert.ok(actions?.items?.properties?.['kind'])

    const screenshot = tools.find(t => t.name === 'env_screenshot')
    assert.equal(screenshot?.inputSchema.properties?.['region']?.type, 'object')
    assert.deepEqual(screenshot?.inputSchema.properties?.['region']?.required, ['x', 'y', 'width', 'height'])
  } finally {
    void session.dispose()
  }
})

test('argument validation reports missing and mistyped parameters', () => {
  const spec = parametersToJsonSchema({
    command: { type: 'string', required: true, description: 'Command line.' },
    timeout_seconds: { type: 'number' },
    extras: { type: 'object', additionalProperties: true, properties: { a: { type: 'string' } } },
  })
  assert.deepEqual(spec.required, ['command'])
  assert.deepEqual(
    validateArgs({ command: { type: 'string', required: true }, timeout_seconds: { type: 'number' } }, {}),
    ['command: required'],
  )
  assert.equal(
    validateArgs(
      { command: { type: 'string', required: true }, timeout_seconds: { type: 'number' } },
      { command: 3, timeout_seconds: 'x' },
    ).length,
    2,
  )
  assert.equal(validateArgs({ command: { type: 'string', required: true } }, { command: 'x' }).length, 0)
})

test('stdio session: handshake, tool list, and refusing to use an unborrowed environment', async () => {
  const dataDir = tmpDir()
  const client = McpClient.start(dataDir)
  try {
    const init = await client.call<{
      protocolVersion: string
      capabilities: { tools: unknown }
      serverInfo: { name: string; version: string }
    }>('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0' },
    })
    assert.equal(init.protocolVersion, '2025-06-18')
    assert.equal(init.serverInfo.name, 'dsh-environments')
    assert.match(init.serverInfo.version, /^\d+\.\d+\.\d+/)
    assert.ok(init.capabilities.tools)
    client.notify('notifications/initialized')

    const listed = await client.call<{ tools: { name: string; description: string; inputSchema: { type: string } }[] }>(
      'tools/list',
    )
    const byName = new Map(listed.tools.map(t => [t.name, t]))
    for (const name of ['env_list', 'env_borrow', 'env_return', 'env_transfer', 'env_exec', 'env_screenshot'])
      assert.ok(byName.has(name), `tools/list lacks ${name}`)
    assert.equal(byName.get('env_exec')?.inputSchema.type, 'object')
    assert.ok((byName.get('env_exec')?.description ?? '').length > 20)

    const list = await client.tool('env_list')
    assert.equal(list.isError, false)
    assert.match(list.text, /Borrowable environments/)
    // The built-in local environment is always there.
    assert.match(list.text, /local: /)

    const call = await client.tool('env_exec', { command: 'echo hi' })
    assert.equal(call.isError, true)
    assert.match(call.text, /nothing is borrowed yet/)

    const invalid = await client.tool('env_exec', {})
    assert.equal(invalid.isError, true)
    assert.match(invalid.text, /invalid arguments: command: required/)

    const unknown = await client.request('tools/call', { name: 'no_such_tool', arguments: {} })
    assert.equal(unknown.error?.code, -32602)

    assert.deepEqual(await client.call('ping'), {})
  } finally {
    await client.close()
  }
})

test('stdio session: borrow, run, read and write, return', needsServer, async () => {
  const dataDir = tmpDir()
  const workspace = tmpDir()
  // The `local` environment starts in the user's home directory: keep everything in a fresh
  // directory so repeated runs never collide, and remove it again.
  const runDir = `mcp-test-${Date.now()}`
  const dir = `${runDir}/dir`
  fs.writeFileSync(path.join(workspace, 'input.txt'), 'from the workspace\n')
  const client = McpClient.start(dataDir, ['--workspace', workspace, '--name', 'test-client'])
  try {
    await client.call('initialize', { protocolVersion: '2025-05-26', capabilities: {}, clientInfo: { name: 'test' } })
    client.notify('notifications/initialized')
    try {
      const borrowed = await client.tool('env_borrow', { environment: 'local' })
      assert.equal(borrowed.isError, false, borrowed.text)
      assert.match(borrowed.text, /Borrowed /)
      assert.match(borrowed.text, /as "local"/)

      const echo = await client.tool('env_exec', { environment: 'local', command: 'echo mcp-hello' })
      assert.equal(echo.isError, false, echo.text)
      assert.match(echo.text, /exit code: 0/)
      assert.match(echo.text, /mcp-hello/)

      const written = await client.tool('env_write_file', {
        environment: 'local',
        path: `${dir}/note.txt`,
        content: 'written by mcp\n',
      })
      assert.equal(written.isError, false, written.text)
      const read = await client.tool('env_read_file', { environment: 'local', path: `${dir}/note.txt` })
      assert.equal(read.isError, false, read.text)
      assert.match(read.text, /written by mcp/)

      const listing = await client.tool('env_list_dir', { environment: 'local', path: dir })
      assert.match(listing.text, /note\.txt/)

      // The workspace side of a transfer is the server's --workspace directory.
      const target = `${dir}/input.txt`
      const copied = await client.tool('env_transfer', {
        source: 'workspace:input.txt',
        destination: `local:${target}`,
      })
      assert.equal(copied.isError, false, copied.text)
      const back = await client.tool('env_read_file', { environment: 'local', path: target })
      assert.match(back.text, /from the workspace/)

      const returned = await client.tool('env_return', { environment: 'local' })
      assert.match(returned.text, /Returned /)
      const after = await client.tool('env_exec', { environment: 'local', command: 'echo no' })
      assert.equal(after.isError, true)
      assert.match(after.text, /not borrowed/)
    } finally {
      // Best effort: the lease is still held unless the assertions above returned it.
      const cleanup = process.platform === 'win32' ? `Remove-Item -Recurse -Force '${runDir}'` : `rm -rf '${runDir}'`
      await client.tool('env_exec', { environment: 'local', command: cleanup })
    }
  } finally {
    await client.close()
  }
})
