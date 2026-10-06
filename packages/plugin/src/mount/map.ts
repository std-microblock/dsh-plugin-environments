// Translation between a mounted session's host-side directory and the environment root.
import path from 'node:path'
import type { Environment } from '../env/environment.ts'

/**
 * Translates between the session's host-side working directory (a placeholder directory or
 * a real local workspace) and the environment's root directory.
 */
export class MountMap {
  readonly env: Environment
  readonly hostRoot: string | undefined
  readonly remoteRoot: string

  constructor({ env, hostRoot, remoteRoot }: { env: Environment; hostRoot?: string | undefined; remoteRoot: string }) {
    this.env = env
    this.hostRoot = hostRoot ? path.resolve(hostRoot) : undefined
    this.remoteRoot = remoteRoot
  }

  /** Path of `p` relative to the host root ('' for the root itself), or undefined when outside it. */
  hostPrefix(p: unknown): string | undefined {
    if (!this.hostRoot || typeof p !== 'string') return undefined
    const win = process.platform === 'win32'
    const norm = win ? p.replace(/\//g, '\\') : p
    const a = win ? norm.toLowerCase() : norm
    const b = win ? this.hostRoot.toLowerCase() : this.hostRoot
    if (a === b) return ''
    const sep = win ? '\\' : '/'
    if (a.startsWith(b.endsWith(sep) ? b : b + sep)) return norm.slice(this.hostRoot.length).replace(/^[\\/]+/, '')
    return undefined
  }

  /** Map a host path under the placeholder root into the environment; other paths pass through. */
  toRemote(p: string): string
  toRemote(p: string | undefined): string | undefined
  toRemote(p: string | undefined): string | undefined {
    const rel = this.hostPrefix(p)
    if (rel === undefined) return p
    if (rel === '') return this.remoteRoot
    return this.env.path.join(this.remoteRoot, ...rel.split(/[\\/]+/))
  }

  resolve(p: string, cwd?: string): string {
    const base = cwd ? this.toRemote(cwd) : this.remoteRoot
    const mapped = this.toRemote(p)
    // Host-absolute paths that are not under the placeholder cannot exist remotely; keep them as-is
    // so the environment reports "not found" instead of silently rewriting them.
    return this.env.resolvePath(mapped, base)
  }
}
