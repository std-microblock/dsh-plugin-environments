// Shell and file tools of a borrowed environment: exec, read/write/edit, list, glob, grep.
import { TEXT_OUTPUT, baseName, clip, formatSize, looksBinary, numbered, sniffImage, stripAnsi } from '../common.ts'
import { IMAGE_OUTPUT, imageValue } from '../image.ts'
import type { LeaseToolContext } from './context.ts'

export function addFileTools({ ctx, env, alias: a, label: name, cwd, abs, add }: LeaseToolContext): void {
  add({
    name: 'exec',
    description: `Run a shell command in the borrowed environment ${name} (${env.info?.os}, shell ${env.info?.shell || 'default'}) and wait for it to finish. Relative paths start at ${cwd}. For long-running or interactive programs use ${a}__process_start.`,
    parameters: {
      command: { type: 'string', required: true, description: "Command line, interpreted by the environment's shell." },
      cwd: { type: 'string', description: `Working directory (default ${cwd}).` },
      timeout_seconds: {
        type: 'number',
        description: 'Kill the command after this many seconds (default 120, max 3600).',
      },
      stdin: { type: 'string', description: "Text written to the command's standard input." },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const timeoutMs = Math.min(3600, Math.max(1, args.timeout_seconds ?? 120)) * 1000
      const started = Date.now()
      const r = await env.exec(
        { command: args.command, cwd: args.cwd ? abs(args.cwd) : cwd },
        { signal: exec.signal, stdin: args.stdin, timeoutMs },
      )
      const secs = ((Date.now() - started) / 1000).toFixed(1)
      const out = stripAnsi(r.stdout.toString('utf8'))
      const err = stripAnsi(r.stderr.toString('utf8'))
      const timedOut = Date.now() - started >= timeoutMs - 50 && r.code === null
      let text = `exit code: ${r.code ?? `none (${r.signal ?? 'killed'})`}${timedOut ? ' — timed out' : ''} (${secs}s)`
      if (out) text += `\n--- stdout ---\n${clip(out)}`
      if (err) text += `\n--- stderr ---\n${clip(err, 10000)}`
      if (!out && !err) text += '\n(no output)'
      return text
    },
  })

  add({
    name: 'read_file',
    description: `Read a text file from ${name}. Returns numbered lines.`,
    parameters: {
      path: { type: 'string', required: true, description: `Absolute path, or relative to ${cwd}.` },
      offset: { type: 'integer', description: '1-based first line (default 1).' },
      limit: { type: 'integer', description: 'Maximum number of lines (default 2000).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const p = abs(args.path)
      const st = await env.stat(p, { signal: exec.signal })
      if (!st) throw new Error(`${p} does not exist`)
      if (st.type === 'dir') throw new Error(`${p} is a directory; use ${a}__list_dir`)
      if (st.size > 20 * 1024 * 1024) {
        throw new Error(
          `${p} is ${formatSize(st.size)}; read a window with ${a}__exec (e.g. head/tail) or copy it with env_transfer`,
        )
      }
      const buf = await env.readFile(p, { signal: exec.signal, maxBytes: 20 * 1024 * 1024 })
      if (looksBinary(buf)) {
        const img = sniffImage(buf)
        throw new Error(
          `${p} is a binary file (${formatSize(buf.length)})${img ? `; use ${a}__read_image to view it` : '; copy it with env_transfer instead'}`,
        )
      }
      return `<path>${p}</path>\n${numbered(buf.toString('utf8'), args.offset ?? 1, args.limit ?? 2000)}`
    },
  })

  add({
    name: 'read_image',
    description: `Read a PNG/JPEG/WebP/GIF image file from ${name} and show it.`,
    parameters: { path: { type: 'string', required: true, description: `Absolute path, or relative to ${cwd}.` } },
    output: IMAGE_OUTPUT,
    async execute(args, exec) {
      const p = abs(args.path)
      const buf = await env.readFile(p, { signal: exec.signal, maxBytes: 30 * 1024 * 1024 })
      const mediaType = sniffImage(buf)
      if (!mediaType) throw new Error(`${p} is not a PNG/JPEG/WebP/GIF image`)
      return imageValue(ctx, exec, buf, { name: baseName(p), text: `<path>${p}</path>`, mediaType })
    },
  })

  add({
    name: 'write_file',
    description: `Create or overwrite a text file in ${name}. Parent directories are created.`,
    parameters: {
      path: { type: 'string', required: true, description: `Absolute path, or relative to ${cwd}.` },
      content: { type: 'string', required: true, description: 'Complete file content.' },
      append: { type: 'boolean', description: 'Append instead of replacing.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const p = abs(args.path)
      const st = await env.writeFile(p, Buffer.from(args.content, 'utf8'), {
        mode: args.append ? 'append' : 'overwrite',
        mkdirs: true,
        signal: exec.signal,
      })
      return `${args.append ? 'Appended to' : 'Wrote'} ${p} (${formatSize(st?.size ?? Buffer.byteLength(args.content))})`
    },
  })

  add({
    name: 'edit_file',
    description: `Replace literal text in a file in ${name}. old_string must match exactly once unless replace_all is true.`,
    parameters: {
      path: { type: 'string', required: true, description: `Absolute path, or relative to ${cwd}.` },
      old_string: { type: 'string', required: true, description: 'Exact text to replace.' },
      new_string: { type: 'string', required: true, description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const p = abs(args.path)
      const raw = (await env.readFile(p, { signal: exec.signal, maxBytes: 20 * 1024 * 1024 })).toString('utf8')
      const crlf = raw.includes('\r\n')
      const text = raw.replaceAll('\r\n', '\n')
      const oldS = args.old_string.replaceAll('\r\n', '\n')
      if (!oldS) throw new Error('old_string must not be empty')
      const count = text.split(oldS).length - 1
      if (count === 0) throw new Error(`old_string was not found in ${p}`)
      if (count > 1 && !args.replace_all)
        throw new Error(`old_string matched ${count} times in ${p}; add context or set replace_all`)
      let next = text.split(oldS).join(args.new_string.replaceAll('\r\n', '\n'))
      if (crlf) next = next.split('\n').join('\r\n')
      await env.writeFile(p, Buffer.from(next, 'utf8'), { mode: 'overwrite', signal: exec.signal })
      return `Edited ${p} (${count} replacement${count > 1 ? 's' : ''})`
    },
  })

  add({
    name: 'list_dir',
    description: `List a directory in ${name}.`,
    parameters: { path: { type: 'string', description: `Directory (default ${cwd}).` } },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const p = abs(args.path ?? '.')
      const entries = await env.readdir(p, { signal: exec.signal })
      const lines = entries
        .slice(0, 1000)
        .map(
          e =>
            `${e.type === 'dir' ? `${e.name}/` : e.name}${e.type === 'file' && e.size !== undefined ? `  ${formatSize(e.size)}` : ''}`,
        )
      return `<path>${p}</path>\n${lines.join('\n') || '(empty)'}${entries.length > 1000 ? `\n… ${entries.length - 1000} more entries` : ''}`
    },
  })

  // Shell-driven environments search with find/grep even without the server capability.
  const shellSearch = env.kind === 'adb' || env.kind === 'ssh'

  if (env.hasCap('glob') || shellSearch) {
    add({
      name: 'glob',
      description: `Find files in ${name} by glob pattern (e.g. "**/*.kt"). Results are relative to the search directory.`,
      parameters: {
        pattern: { type: 'string', required: true, description: 'Glob pattern.' },
        path: { type: 'string', description: `Directory to search (default ${cwd}).` },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const base = abs(args.path ?? '.')
        const r = await env.glob(args.pattern, { cwd: base, limit: 500, signal: exec.signal })
        return `<path>${base}</path>\n${r.paths.join('\n') || 'No files found'}${r.truncated ? '\n(results truncated)' : ''}`
      },
    })
  }

  if (env.hasCap('grep') || shellSearch) {
    add({
      name: 'grep',
      description: `Search file contents in ${name} with a regular expression.`,
      parameters: {
        pattern: {
          type: 'string',
          required: true,
          description: 'Regular expression (or literal text with literal=true).',
        },
        path: { type: 'string', description: `File or directory to search (default ${cwd}).` },
        glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts".' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
        literal: { type: 'boolean', description: 'Treat the pattern as literal text.' },
        files_only: { type: 'boolean', description: 'Only list matching files.' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const r = await env.grep(args.pattern, {
          cwd,
          path: args.path ? abs(args.path) : undefined,
          glob: args.glob,
          ignoreCase: args.ignore_case,
          literal: args.literal,
          filesOnly: args.files_only,
          limit: 300,
          signal: exec.signal,
        })
        if (args.files_only) return r.files.join('\n') || 'No matches'
        return (
          (r.matches.map(m => `${m.path}:${m.line}: ${m.text}`).join('\n') || 'No matches') +
          (r.truncated ? '\n(results truncated)' : '')
        )
      },
    })
  }
}
