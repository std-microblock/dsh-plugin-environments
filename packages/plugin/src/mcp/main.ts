#!/usr/bin/env node
// `dsh-env-mcp`: the environments of dsh-plugin-environments as a Model Context Protocol server.
//
//   node dist/mcp.js [--data-dir <dir>] [--workspace <dir>] [--adb <path>]
//                    [--no-adb-discovery] [--allow <id,id>] [--name <title>] [--version]
//
// It speaks MCP over stdio (spawned by the client) and reads the same environment definitions the
// plugin's GUI writes, so an MCP client such as Antigravity, Claude Code or Codex can borrow the
// same devices. Every lease it takes is visible to the DSH UI, named after the client.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { EnvironmentManager } from '../manager/manager.ts'
import { PACKAGE_ROOT } from '../paths.ts'
import { McpStdioServer } from './server.ts'
import { McpSession } from './session.ts'
import { buildMcpTools } from './tools.ts'

const HELP = `dsh-env-mcp — environments for MCP clients (stdio)

Usage: node dist/mcp.js [options]

  --data-dir <dir>        environment definitions (default $DSH_ENV_MCP_DATA_DIR,
                          else $DSH_HOME/storages/environments)
  --workspace <dir>       directory plain transfer paths are relative to
                          (default $DSH_ENV_MCP_WORKSPACE, else the current directory)
  --adb <path>            adb executable (default $DSH_ENV_ADB, else "adb" on PATH)
  --no-adb-discovery      do not list the devices of "adb devices" automatically
  --allow <ids>           only expose these environment ids (comma separated, repeatable)
  --name <title>          name shown to a human in the DeepSeek Harness lease list
  --version               print the version and exit
  --help                  print this help and exit

The server speaks the Model Context Protocol over stdin/stdout and logs to stderr.
Configure it in an MCP client as a stdio server: command "node", argument the path of
dist/mcp.js (or the "dsh-env-mcp" bin script of this package).
`

export interface Options {
  dataDir: string
  workspaceDir: string
  adb: string
  autoDiscoverAdb: boolean
  allow: string[] | undefined
  name: string | undefined
  help: boolean
  versionOnly: boolean
}

function dshHome(env: NodeJS.ProcessEnv): string {
  return env['DSH_HOME'] || path.join(os.homedir(), '.dsh')
}

/** Version of the plugin package this server was built from. */
export function readVersion(): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Parse the command line (`--flag`, `--opt value`, `--opt=value`). */
export function parseOptions(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Options {
  const { values } = parseArgs({
    args: argv.filter(a => a !== '--'),
    options: {
      'data-dir': { type: 'string' },
      workspace: { type: 'string' },
      adb: { type: 'string' },
      'no-adb-discovery': { type: 'boolean' },
      allow: { type: 'string', multiple: true },
      name: { type: 'string' },
      version: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  })
  const allow = (values.allow ?? [])
    .flatMap(v => v.split(','))
    .map(v => v.trim())
    .filter(Boolean)
  const envAllow = (env['DSH_ENV_MCP_ALLOW'] ?? '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
  const ids = allow.length > 0 ? allow : envAllow
  return {
    dataDir: path.resolve(
      values['data-dir'] || env['DSH_ENV_MCP_DATA_DIR'] || path.join(dshHome(env), 'storages', 'environments'),
    ),
    workspaceDir: path.resolve(values.workspace || env['DSH_ENV_MCP_WORKSPACE'] || process.cwd()),
    adb: values.adb || env['DSH_ENV_ADB'] || 'adb',
    autoDiscoverAdb: values['no-adb-discovery'] !== true,
    allow: ids.length > 0 ? ids : undefined,
    name: values.name ?? env['DSH_ENV_MCP_NAME'],
    help: values.help === true,
    versionOnly: values.version === true,
  }
}

function log(message: string): void {
  process.stderr.write(`[dsh-env-mcp] ${message}\n`)
}

/** Run the server on stdin/stdout until the client closes the connection. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: Options
  try {
    options = parseOptions(argv)
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  const version = readVersion()
  if (options.versionOnly) {
    process.stdout.write(`${version}\n`)
    return 0
  }

  const manager = new EnvironmentManager({
    dataDir: options.dataDir,
    autoDiscoverAdb: options.autoDiscoverAdb,
    adb: options.adb,
    logger: {
      info: (format: string, ...args: unknown[]) => log(format.replace(/%s/g, () => String(args.shift()))),
      warn: (format: string, ...args: unknown[]) =>
        log(`warning: ${format.replace(/%s/g, () => String(args.shift()))}`),
    },
  })
  try {
    manager.load()
  } catch (e) {
    log(`cannot read the environment definitions in ${options.dataDir}: ${String(e)}`)
    return 1
  }
  const session = new McpSession({
    manager,
    workspaceDir: options.workspaceDir,
    clientName: options.name,
    allow: options.allow,
    log,
  })
  const tools = buildMcpTools(session)
  const server = new McpStdioServer({
    tools,
    version,
    stdin: process.stdin,
    stdout: process.stdout,
    log,
    onClient: name => session.setClientName(name),
  })

  let stopping = false
  const shutdown = async (why: string) => {
    if (stopping) return
    stopping = true
    log(`stopping (${why})`)
    await session.dispose()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason: unknown) => log(`unhandled rejection: ${String(reason)}`))

  const defs = manager.definitions()
  log(
    `v${version} ready: ${defs.length} environment${defs.length === 1 ? '' : 's'} from ${options.dataDir}; workspace ${options.workspaceDir}`,
  )
  if (options.allow) log(`allow-list: ${options.allow.join(', ')}`)

  try {
    await server.run()
  } finally {
    await session.dispose()
  }
  if (!stopping) log('stdin closed; every borrowed environment was released')
  return 0
}

/** Whether this file is the process entry point (so importing it in tests does nothing). */
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const self = fileURLToPath(import.meta.url)
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
  return norm(entry) === norm(self)
}

if (isEntryPoint()) {
  void main().then(
    code => process.exit(code),
    (e: unknown) => {
      log(`fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
      process.exit(1)
    },
  )
}
