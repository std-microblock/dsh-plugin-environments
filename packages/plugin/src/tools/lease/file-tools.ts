// Shell and file tools of borrowed environments: exec, read/write/edit, list, glob, grep.
import { TEXT_OUTPUT, baseName, clip, formatSize, looksBinary, numbered, sniffImage, stripAnsi } from '../common.ts'
import { IMAGE_OUTPUT, imageValue } from '../image.ts'
import { ENV_PARAM, type EnvToolContext } from './context.ts'

/** Shell-driven environments search with find/grep even without the server capability. */
const shellSearch = (kind: string) => kind === 'adb' || kind === 'ssh'

export function addFileTools({ ctx, add, use }: EnvToolContext): void {
  const execTarget = use({ name: 'exec', gui: false })
  add({
    name: 'exec',
    description:
      "Run a shell command in a borrowed environment (its own shell: sh/bash on Linux and Android, PowerShell or cmd on Windows, as env_borrow reported) and wait for it to finish. Relative paths start at the environment's working directory. For long-running or interactive programs use env_process_start.",
    parameters: {
      ...ENV_PARAM,
      command: { type: 'string', required: true, description: "Command line, interpreted by the environment's shell." },
      cwd: { type: 'string', description: "Working directory (default: the environment's)." },
      timeout_seconds: {
        type: 'number',
        description: 'Kill the command after this many seconds (default 120, max 3600).',
      },
      stdin: { type: 'string', description: "Text written to the command's standard input." },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const t = await execTarget(exec, args.environment)
      const timeoutMs = Math.min(3600, Math.max(1, args.timeout_seconds ?? 120)) * 1000
      const started = Date.now()
      const r = await t.env.exec(
        { command: args.command, cwd: args.cwd ? t.abs(args.cwd) : t.cwd },
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

  const readTarget = use({ name: 'read_file', gui: false })
  add({
    name: 'read_file',
    description: 'Read a text file from a borrowed environment. Returns numbered lines.',
    parameters: {
      ...ENV_PARAM,
      path: { type: 'string', required: true, description: "Absolute path, or relative to the environment's cwd." },
      offset: { type: 'integer', description: '1-based first line (default 1).' },
      limit: { type: 'integer', description: 'Maximum number of lines (default 2000).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const t = await readTarget(exec, args.environment)
      const p = t.abs(args.path)
      const st = await t.env.stat(p, { signal: exec.signal })
      if (!st) throw new Error(`${p} does not exist`)
      if (st.type === 'dir') throw new Error(`${p} is a directory; use env_list_dir`)
      if (st.size > 20 * 1024 * 1024) {
        throw new Error(
          `${p} is ${formatSize(st.size)}; read a window with env_exec (e.g. head/tail) or copy it with env_transfer`,
        )
      }
      const buf = await t.env.readFile(p, { signal: exec.signal, maxBytes: 20 * 1024 * 1024 })
      if (looksBinary(buf)) {
        const img = sniffImage(buf)
        throw new Error(
          `${p} is a binary file (${formatSize(buf.length)})${img ? '; use env_read_image to view it' : '; copy it with env_transfer instead'}`,
        )
      }
      return `<path>${p}</path>\n${numbered(buf.toString('utf8'), args.offset ?? 1, args.limit ?? 2000)}`
    },
  })

  const imageTarget = use({ name: 'read_image', gui: false })
  add({
    name: 'read_image',
    description: 'Read a PNG/JPEG/WebP/GIF image file from a borrowed environment and show it.',
    parameters: {
      ...ENV_PARAM,
      path: { type: 'string', required: true, description: "Absolute path, or relative to the environment's cwd." },
    },
    output: IMAGE_OUTPUT,
    async execute(args, exec) {
      const t = await imageTarget(exec, args.environment)
      const p = t.abs(args.path)
      const buf = await t.env.readFile(p, { signal: exec.signal, maxBytes: 30 * 1024 * 1024 })
      const mediaType = sniffImage(buf)
      if (!mediaType) throw new Error(`${p} is not a PNG/JPEG/WebP/GIF image`)
      return imageValue(ctx, exec, buf, { name: baseName(p), text: `<path>${p}</path>`, mediaType })
    },
  })

  const writeTarget = use({ name: 'write_file', gui: false })
  add({
    name: 'write_file',
    description: 'Create or overwrite a text file in a borrowed environment. Parent directories are created.',
    parameters: {
      ...ENV_PARAM,
      path: { type: 'string', required: true, description: "Absolute path, or relative to the environment's cwd." },
      content: { type: 'string', required: true, description: 'Complete file content.' },
      append: { type: 'boolean', description: 'Append instead of replacing.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const t = await writeTarget(exec, args.environment)
      const p = t.abs(args.path)
      const st = await t.env.writeFile(p, Buffer.from(args.content, 'utf8'), {
        mode: args.append ? 'append' : 'overwrite',
        mkdirs: true,
        signal: exec.signal,
      })
      return `${args.append ? 'Appended to' : 'Wrote'} ${p} on ${t.alias} (${formatSize(st?.size ?? Buffer.byteLength(args.content))})`
    },
  })

  const editTarget = use({ name: 'edit_file', gui: false })
  add({
    name: 'edit_file',
    description:
      'Replace literal text in a file in a borrowed environment. old_string must match exactly once unless replace_all is true.',
    parameters: {
      ...ENV_PARAM,
      path: { type: 'string', required: true, description: "Absolute path, or relative to the environment's cwd." },
      old_string: { type: 'string', required: true, description: 'Exact text to replace.' },
      new_string: { type: 'string', required: true, description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const t = await editTarget(exec, args.environment)
      const p = t.abs(args.path)
      const raw = (await t.env.readFile(p, { signal: exec.signal, maxBytes: 20 * 1024 * 1024 })).toString('utf8')
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
      await t.env.writeFile(p, Buffer.from(next, 'utf8'), { mode: 'overwrite', signal: exec.signal })
      return `Edited ${p} on ${t.alias} (${count} replacement${count > 1 ? 's' : ''})`
    },
  })

  const listTarget = use({ name: 'list_dir', gui: false })
  add({
    name: 'list_dir',
    description: 'List a directory in a borrowed environment.',
    parameters: { ...ENV_PARAM, path: { type: 'string', description: "Directory (default: the environment's cwd)." } },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const t = await listTarget(exec, args.environment)
      const p = t.abs(args.path ?? '.')
      const entries = await t.env.readdir(p, { signal: exec.signal })
      const lines = entries
        .slice(0, 1000)
        .map(
          e =>
            `${e.type === 'dir' ? `${e.name}/` : e.name}${e.type === 'file' && e.size !== undefined ? `  ${formatSize(e.size)}` : ''}`,
        )
      return `<path>${p}</path>\n${lines.join('\n') || '(empty)'}${entries.length > 1000 ? `\n… ${entries.length - 1000} more entries` : ''}`
    },
  })

  const globTarget = use({ name: 'glob', gui: false, supports: env => env.hasCap('glob') || shellSearch(env.kind) })
  add({
    name: 'glob',
    description:
      'Find files in a borrowed environment by glob pattern (e.g. "**/*.kt"). Results are relative to the search directory.',
    parameters: {
      ...ENV_PARAM,
      pattern: { type: 'string', required: true, description: 'Glob pattern.' },
      path: { type: 'string', description: "Directory to search (default: the environment's cwd)." },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const t = await globTarget(exec, args.environment)
      const base = t.abs(args.path ?? '.')
      const r = await t.env.glob(args.pattern, { cwd: base, limit: 500, signal: exec.signal })
      return `<path>${base}</path>\n${r.paths.join('\n') || 'No files found'}${r.truncated ? '\n(results truncated)' : ''}`
    },
  })

  const grepTarget = use({ name: 'grep', gui: false, supports: env => env.hasCap('grep') || shellSearch(env.kind) })
  add({
    name: 'grep',
    description: 'Search file contents in a borrowed environment with a regular expression.',
    parameters: {
      ...ENV_PARAM,
      pattern: {
        type: 'string',
        required: true,
        description: 'Regular expression (or literal text with literal=true).',
      },
      path: { type: 'string', description: "File or directory to search (default: the environment's cwd)." },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts".' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
      literal: { type: 'boolean', description: 'Treat the pattern as literal text.' },
      files_only: { type: 'boolean', description: 'Only list matching files.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const t = await grepTarget(exec, args.environment)
      const r = await t.env.grep(args.pattern, {
        cwd: t.cwd,
        path: args.path ? t.abs(args.path) : undefined,
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
