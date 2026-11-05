// Resolving an SSH destination through the user's ssh_config.
//
// ssh2 only speaks the protocol: it takes an address and knows nothing about `~/.ssh/config`.
// Rather than re-implement that format (Include, Match, wildcards, tokens), ask OpenSSH:
// `ssh -G <host>` prints the effective configuration for a destination without connecting.
// ssh2 has no proxy support either, but it accepts any duplex stream as its transport, so a
// ProxyCommand or ProxyJump runs as a child process whose stdio becomes that stream.
import { execFile, spawn } from 'node:child_process'
import os from 'node:os'
import { Duplex } from 'node:stream'
import type { ReadableWritablePair } from 'node:stream/web'
import { promisify } from 'node:util'

/** The parts of `ssh -G` output that an SSH environment uses. */
export interface SshTarget {
  /** `HostName`: the address to connect to. */
  host: string
  port: number
  user: string
  /** `IdentityFile` entries in config order, with `~` expanded; includes OpenSSH's defaults. */
  identityFiles: string[]
  proxyJump?: string
  /** Tokens such as `%h` are not expanded yet. */
  proxyCommand?: string
}

/** Expand a leading `~` (`~`, `~/x`, `~\x`). */
export function expandHome(p: string): string {
  return p.replace(/^~(?=$|[\\/])/, os.homedir())
}

/** Parse `ssh -G` output; `undefined` when it names no host. */
export function parseSshG(text: string): SshTarget | undefined {
  const values = new Map<string, string>()
  const identityFiles: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\S+)\s+(.*\S)/.exec(line.trim())
    if (!match) continue
    const key = (match[1] ?? '').toLowerCase()
    const value = match[2] ?? ''
    if (key === 'identityfile') identityFiles.push(expandHome(value))
    else if (value !== 'none' && !values.has(key)) values.set(key, value)
  }
  const host = values.get('hostname')
  if (!host) return undefined
  const proxyJump = values.get('proxyjump')
  const proxyCommand = values.get('proxycommand')
  return {
    host,
    port: Number(values.get('port') ?? 22),
    user: values.get('user') ?? os.userInfo().username,
    identityFiles,
    ...(proxyJump ? { proxyJump } : {}),
    ...(proxyCommand ? { proxyCommand } : {}),
  }
}

/**
 * Resolve a destination with `ssh -G`. `undefined` when that fails (no ssh client, a broken
 * config); the caller then connects to the host literally.
 */
export async function resolveSshTarget(host: string, signal?: AbortSignal): Promise<SshTarget | undefined> {
  try {
    const { stdout } = await promisify(execFile)('ssh', ['-G', '--', host], {
      timeout: 10_000,
      windowsHide: true,
      ...(signal ? { signal } : {}),
    })
    return parseSshG(stdout)
  } catch {
    return undefined
  }
}

/** Where a proxy has to deliver the connection. */
export interface ProxyDestination {
  /** The destination as the environment names it (`%n`). */
  alias: string
  host: string
  port: number
  user: string
}

/** Expand the tokens ssh_config(5) allows in ProxyCommand. */
export function expandProxyTokens(command: string, dest: ProxyDestination): string {
  const values: Record<string, string> = {
    '%': '%',
    h: dest.host,
    n: dest.alias,
    p: String(dest.port),
    r: dest.user,
  }
  return command.replace(/%([%hnpr])/g, (_, token: string) => values[token] ?? '')
}

/**
 * The `ssh` arguments for a ProxyJump chain: tunnel with `-W` through the last hop, reaching it
 * through the earlier hops with `-J`. ssh resolves every hop through the same config.
 */
export function proxyJumpArgs(proxyJump: string, dest: ProxyDestination): string[] {
  const hops = proxyJump.split(',').map(hop => hop.trim())
  const last = hops.pop() ?? ''
  const args = ['-o', 'BatchMode=yes', '-W', `${dest.host}:${dest.port}`]
  if (hops.length > 0) args.push('-J', hops.join(','))
  // The command-line destination takes neither a port nor IPv6 brackets, unlike a ProxyJump hop.
  const hop = /^(?:(.+)@)?(?:\[([^\]]+)\]|([^:@]+))(?::(\d+))?$/.exec(last)
  if (!hop || last.startsWith('ssh://')) return [...args, last]
  const [, user, bracketed, plain, port] = hop
  if (user) args.push('-l', user)
  if (port) args.push('-p', port)
  args.push(bracketed ?? plain ?? last)
  return args
}

/** A proxy process whose stdio serves as the transport of an ssh2 connection. */
export interface SshProxy {
  sock: Duplex
  kill(): void
  /**
   * Settles once the proxy has exited, with the reason it failed (its last stderr line), or `''`.
   * ssh2 only sees the stream end, so this is what explains a failed connection.
   */
  closed: Promise<string>
}

/** Start the proxy that `target` configures, if any. ProxyCommand takes precedence, as in OpenSSH. */
export function openProxy(target: SshTarget, dest: ProxyDestination): SshProxy | undefined {
  let child
  if (target.proxyCommand) {
    child = spawn(expandProxyTokens(target.proxyCommand, dest), { shell: true, windowsHide: true })
  } else if (target.proxyJump) {
    child = spawn('ssh', proxyJumpArgs(target.proxyJump, dest), { windowsHide: true })
  } else {
    return undefined
  }
  // Node accepts Node streams here; @types/node only declares the web-stream form.
  const sock = Duplex.from({ readable: child.stdout, writable: child.stdin } as unknown as ReadableWritablePair)
  let stderr = ''
  let spawnError = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    stderr = (stderr + d).slice(-4000)
  })
  child.once('error', e => {
    spawnError = e.message
  })
  const closed = new Promise<string>(resolve => {
    child.once('close', code => {
      sock.destroy()
      const lastLine = stderr.trim().split(/\r?\n/).pop()
      resolve(lastLine || spawnError || (code ? `proxy exited with code ${code}` : ''))
    })
  })
  return { sock, kill: () => child.kill(), closed }
}
