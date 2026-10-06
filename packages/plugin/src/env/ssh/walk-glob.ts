// Glob by walking readdir, for environments without `find`.
import type { Environment } from '../environment.ts'
import { globToRegExp } from '../posix-shell.ts'
import type { DirEntry, GlobOptions, GlobOutcome } from '../types.ts'

export async function walkGlob(
  env: Environment,
  pattern: string,
  { cwd = '', limit = 1000, hidden = false, signal }: GlobOptions = {},
): Promise<GlobOutcome> {
  const re = globToRegExp(pattern)
  const P = env.path
  const paths: string[] = []
  let truncated = false
  let visited = 0
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (truncated || signal?.aborted) return
    let entries: DirEntry[]
    try {
      entries = await env.readdir(dir)
    } catch {
      return
    }
    for (const e of entries) {
      if (!hidden && e.name.startsWith('.')) continue
      if (e.name === 'node_modules' || e.name === '.git') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (re.test(r)) {
        if (paths.length >= limit) {
          truncated = true
          return
        }
        paths.push(r)
      }
      if (e.type === 'dir' && ++visited < 20000) await walk(P.join(dir, e.name), r)
    }
  }
  await walk(cwd, '')
  return { paths, truncated, cwd }
}
