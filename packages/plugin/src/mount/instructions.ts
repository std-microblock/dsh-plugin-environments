// Project instruction files (AGENTS.md, CLAUDE.md) read from a mounted environment.
import type { Environment } from '../env/environment.ts'

export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md']
const INSTRUCTION_MAX = 64 * 1024

/**
 * Load AGENTS.md-style instruction files from the project root (nearest ancestor with .git)
 * down to the mount root, outermost first.
 */
export async function loadInstructions(env: Environment, root: string): Promise<string> {
  const P = env.path
  let dirs = [root]
  const chain = [root]
  let dir = root
  for (let i = 0; i < 6; i++) {
    if (await env.stat(P.join(dir, '.git')).catch(() => null)) {
      dirs = [...chain]
      break
    }
    const parent = P.dirname(dir)
    if (parent === dir) break
    dir = parent
    chain.unshift(dir)
  }
  const parts: string[] = []
  let budget = INSTRUCTION_MAX
  for (const d of dirs) {
    for (const name of INSTRUCTION_FILES) {
      const file = P.join(d, name)
      const st = await env.stat(file).catch(() => null)
      if (st?.type !== 'file' || st.size === 0) continue
      const buf = await env.readFile(file, { maxBytes: 1024 * 1024 }).catch(() => undefined)
      if (!buf || buf.includes(0)) continue
      let text = buf
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trim()
      if (!text) continue
      if (text.length > budget) text = `${text.slice(0, budget)}\n… (truncated)`
      budget -= text.length
      parts.push(`<instructions path="${file}">\n${text}\n</instructions>`)
      break
    }
    if (budget <= 0) break
  }
  if (parts.length === 0) return ''
  return `Project instructions from the mounted environment. Follow them like AGENTS.md instructions; files nearer the working directory take precedence.\n\n${parts.join('\n\n')}`
}
