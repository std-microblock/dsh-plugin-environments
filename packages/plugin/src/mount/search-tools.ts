// glob/grep for mounted sessions, backed by the environment's native search.
import type { DefineToolFn } from '../deps.ts'
import { agentOf, type PluginContext } from '../host-api.ts'
import { TEXT_OUTPUT } from '../tools/common.ts'
import type { MountMap } from './map.ts'

export function registerSearchTools(sctx: PluginContext, defineTool: DefineToolFn, map: MountMap): void {
  const env = map.env
  sctx.tools.register(
    defineTool({
      name: 'glob',
      description:
        'Find files by glob pattern (e.g. "**/*.ts", "src/**/test_*.py"). Results are paths relative to the search directory, newest first.',
      parameters: {
        pattern: { type: 'string', required: true, description: 'Glob pattern.' },
        path: { type: 'string', description: 'Directory to search (default: the working directory).' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const base = map.resolve(args.path ?? '.', agentOf(exec)?.session.header.cwd)
        const r = await env.glob(args.pattern, { cwd: base, limit: 200, signal: exec.signal })
        if (r.paths.length === 0) return 'No files found'
        return `${r.paths.join('\n')}${r.truncated ? '\n(Results are truncated. Use a more specific path or pattern.)' : ''}`
      },
    }),
  )
  sctx.tools.register(
    defineTool({
      name: 'grep',
      description: 'Search file contents with a regular expression. Returns matching lines as path:line: text.',
      parameters: {
        pattern: {
          type: 'string',
          required: true,
          description: 'Regular expression (Rust/ripgrep syntax where available).',
        },
        path: { type: 'string', description: 'File or directory to search (default: the working directory).' },
        include: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts".' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
        files_only: { type: 'boolean', description: 'Only list matching file paths.' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const sessionCwd = agentOf(exec)?.session.header.cwd
        const cwd = map.resolve('.', sessionCwd)
        const r = await env.grep(args.pattern, {
          cwd,
          path: args.path ? map.resolve(args.path, sessionCwd) : undefined,
          glob: args.include,
          ignoreCase: args.ignore_case,
          filesOnly: args.files_only,
          limit: 250,
          signal: exec.signal,
        })
        if (args.files_only) return r.files.join('\n') || 'No files found'
        if (r.matches.length === 0) return 'No files found'
        const byFile = new Map<string, string[]>()
        for (const m of r.matches) {
          let lines = byFile.get(m.path)
          if (!lines) byFile.set(m.path, (lines = []))
          lines.push(`  Line ${m.line}: ${m.text}`)
        }
        const lines = [`Found ${r.matches.length} matches${r.truncated ? ' (truncated)' : ''}`]
        for (const [file, ms] of byFile) lines.push('', `${file}:`, ...ms)
        return lines.join('\n')
      },
    }),
  )
}
