// Tools contributed for one borrowed environment. Every tool name carries the lease alias prefix.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { TEXT_OUTPUT, IMAGE_RESULT_SCHEMA, clip, numbered, looksBinary, formatSize, imageValue, renderImageResult, sniffImage, baseName } from './common.js'

/** Output collector for background processes started through process_start. */
class ManagedProcess {
  constructor(id, proc, command) {
    this.id = id
    this.proc = proc
    this.command = command
    this.buffer = ''
    this.total = 0
    this.exit = undefined
    this.startedAt = Date.now()
    this.waiters = []
    const append = d => {
      const s = d.toString('utf8')
      this.buffer += s
      this.total += s.length
      if (this.buffer.length > 1024 * 1024) this.buffer = this.buffer.slice(-512 * 1024)
      this.notify()
    }
    proc.stdout?.on('data', append)
    if (proc.stderr && proc.stderr !== proc.stdout) proc.stderr.on('data', append)
    proc.exited.then(exit => { this.exit = exit; this.notify() })
  }

  notify() {
    for (const w of this.waiters.splice(0)) w()
  }

  take() {
    const out = this.buffer
    this.buffer = ''
    return out
  }

  waitForOutput(ms, signal) {
    if (this.buffer.length > 0 || this.exit) return Promise.resolve()
    return new Promise(resolve => {
      const t = setTimeout(done, ms)
      function done() { clearTimeout(t); resolve() }
      this.waiters.push(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r(?!\n)/g, '\n')
}

function compactUiXml(xml) {
  const nodes = []
  const re = /<node\b([^>]*)\/?>/g
  let m
  while ((m = re.exec(xml))) {
    const attrs = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], a[2]]))
    const label = attrs.text || attrs['content-desc']
    const id = attrs['resource-id']
    const clickable = attrs.clickable === 'true'
    if (!label && !id && !clickable) continue
    const cls = (attrs.class ?? '').split('.').pop()
    const bounds = attrs.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    const center = bounds ? ` @(${Math.round((+bounds[1] + +bounds[3]) / 2)},${Math.round((+bounds[2] + +bounds[4]) / 2)})` : ''
    nodes.push(`${cls}${id ? ` #${id.split('/').pop()}` : ''}${label ? ` "${label}"` : ''}${clickable ? ' [clickable]' : ''}${attrs.checked === 'true' ? ' [checked]' : ''}${attrs.enabled === 'false' ? ' [disabled]' : ''}${center}`)
  }
  return nodes.join('\n')
}

/**
 * Build the tool definitions for a lease.
 * @param {object} o
 * @param {object} o.ctx - plugin context (attachments, llm)
 * @param {Function} o.defineTool
 * @param {import('../manager.js').Lease} o.lease
 * @param {(exec) => Promise<{env, cwd}>} o.workspaceOf - the session's own workspace (for APK sources)
 */
export function leaseTools({ ctx, defineTool, lease, workspaceOf }) {
  const env = lease.env
  const a = lease.alias
  const name = `${lease.def.name} (${a})`
  const caps = env.caps
  const P = env.path
  const cwd = env.info?.cwd
  const abs = p => env.resolvePath(p ?? '.', cwd)
  const processes = new Map()
  let procSeq = 0
  const tools = []
  const add = def => tools.push(defineTool({ ...def, name: `${a}__${def.name}` }))

  add({
    name: 'exec',
    description: `Run a shell command in the borrowed environment ${name} (${env.info?.os}, shell ${env.info?.shell || 'default'}) and wait for it to finish. Relative paths start at ${cwd}. For long-running or interactive programs use ${a}__process_start.`,
    parameters: {
      command: { type: 'string', required: true, description: 'Command line, interpreted by the environment\'s shell.' },
      cwd: { type: 'string', description: `Working directory (default ${cwd}).` },
      timeout_seconds: { type: 'number', description: 'Kill the command after this many seconds (default 120, max 3600).' },
      stdin: { type: 'string', description: 'Text written to the command\'s standard input.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const timeoutMs = Math.min(3600, Math.max(1, args.timeout_seconds ?? 120)) * 1000
      const started = Date.now()
      const r = await env.exec({ command: args.command, cwd: args.cwd ? abs(args.cwd) : cwd }, { signal: exec.signal, stdin: args.stdin, timeoutMs })
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
      if (st.size > 20 * 1024 * 1024) throw new Error(`${p} is ${formatSize(st.size)}; read a window with ${a}__exec (e.g. head/tail) or copy it with env_transfer`)
      const buf = await env.readFile(p, { signal: exec.signal, maxBytes: 20 * 1024 * 1024 })
      if (looksBinary(buf)) {
        const img = sniffImage(buf)
        throw new Error(`${p} is a binary file (${formatSize(buf.length)})${img ? `; use ${a}__read_image to view it` : '; copy it with env_transfer instead'}`)
      }
      return `<path>${p}</path>\n${numbered(buf.toString('utf8'), args.offset ?? 1, args.limit ?? 2000)}`
    },
  })

  add({
    name: 'read_image',
    description: `Read a PNG/JPEG/WebP/GIF image file from ${name} and show it.`,
    parameters: { path: { type: 'string', required: true, description: `Absolute path, or relative to ${cwd}.` } },
    output: { schema: IMAGE_RESULT_SCHEMA, render: renderImageResult },
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
      const st = await env.writeFile(p, Buffer.from(args.content, 'utf8'), { mode: args.append ? 'append' : 'overwrite', mkdirs: true, signal: exec.signal })
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
      if (count > 1 && !args.replace_all) throw new Error(`old_string matched ${count} times in ${p}; add context or set replace_all`)
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
      const lines = entries.slice(0, 1000).map(e => `${e.type === 'dir' ? `${e.name}/` : e.name}${e.type === 'file' && e.size !== undefined ? `  ${formatSize(e.size)}` : ''}`)
      return `<path>${p}</path>\n${lines.join('\n') || '(empty)'}${entries.length > 1000 ? `\n… ${entries.length - 1000} more entries` : ''}`
    },
  })

  if (caps.has('glob') || env.kind === 'adb' || env.kind === 'ssh') {
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

  if (caps.has('grep') || env.kind === 'adb' || env.kind === 'ssh') {
    add({
      name: 'grep',
      description: `Search file contents in ${name} with a regular expression.`,
      parameters: {
        pattern: { type: 'string', required: true, description: 'Regular expression (or literal text with literal=true).' },
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
          cwd, path: args.path ? abs(args.path) : undefined, glob: args.glob, ignoreCase: args.ignore_case, literal: args.literal, filesOnly: args.files_only, limit: 300, signal: exec.signal,
        })
        if (args.files_only) return r.files.join('\n') || 'No matches'
        return (r.matches.map(m => `${m.path}:${m.line}: ${m.text}`).join('\n') || 'No matches') + (r.truncated ? '\n(results truncated)' : '')
      },
    })
  }

  add({
    name: 'process_start',
    description: `Start a long-running or interactive program in ${name} without waiting for it. Returns a process id for ${a}__process_io and ${a}__process_kill. Use pty=true for programs that need a terminal.`,
    parameters: {
      command: { type: 'string', required: true, description: 'Command line, interpreted by the environment\'s shell.' },
      cwd: { type: 'string', description: `Working directory (default ${cwd}).` },
      pty: { type: 'boolean', description: 'Run inside a pseudo-terminal.' },
      wait_ms: { type: 'integer', description: 'Collect initial output for this long (default 1500).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const proc = await env.spawn({ command: args.command, cwd: args.cwd ? abs(args.cwd) : cwd, ...args.pty ? { pty: { rows: 40, cols: 120 } } : {} })
      const id = `p${++procSeq}`
      const mp = new ManagedProcess(id, proc, args.command)
      processes.set(id, mp)
      await new Promise(r => setTimeout(r, Math.min(30000, args.wait_ms ?? 1500)))
      void exec
      const out = stripAnsi(mp.take())
      return `process ${id} ${mp.exit ? `exited with code ${mp.exit.code}` : 'running'}${proc.pid ? ` (pid ${proc.pid})` : ''}\n${out ? clip(out) : '(no output yet)'}`
    },
  })

  add({
    name: 'process_io',
    description: `Send input to and/or read new output from a process started with ${a}__process_start.`,
    parameters: {
      id: { type: 'string', required: true, description: 'Process id, e.g. "p1".' },
      input: { type: 'string', description: 'Text to write to standard input (include "\\n" to press Enter).' },
      close_stdin: { type: 'boolean', description: 'Close standard input after writing.' },
      wait_ms: { type: 'integer', description: 'Wait up to this long for new output (default 1000, max 60000).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const mp = processes.get(args.id)
      if (!mp) throw new Error(`unknown process ${args.id}; running: ${[...processes.keys()].join(', ') || 'none'}`)
      if (args.input !== undefined && !mp.exit) await mp.proc.write(Buffer.from(args.input, 'utf8'))
      if (args.close_stdin) mp.proc.end()
      await mp.waitForOutput(Math.min(60000, args.wait_ms ?? 1000), exec.signal)
      if (!mp.exit) await new Promise(r => setTimeout(r, 150))
      const out = stripAnsi(mp.take())
      return `process ${mp.id}: ${mp.exit ? `exited with code ${mp.exit.code ?? mp.exit.signal}` : 'running'}\n${out ? clip(out) : '(no new output)'}`
    },
  })

  add({
    name: 'process_kill',
    description: `Stop a process started with ${a}__process_start (kills its whole process tree).`,
    parameters: { id: { type: 'string', required: true, description: 'Process id.' } },
    output: TEXT_OUTPUT,
    async execute(args) {
      const mp = processes.get(args.id)
      if (!mp) throw new Error(`unknown process ${args.id}`)
      await mp.proc.kill()
      await Promise.race([mp.proc.exited, new Promise(r => setTimeout(r, 3000))])
      processes.delete(args.id)
      return `process ${args.id} stopped`
    },
  })

  add({
    name: 'tunnel',
    description: `Manage network tunnels for ${name}. direction "to_env" makes a port of the environment reachable at 127.0.0.1:<local_port> on the harness host (like ssh -L); "from_env" makes a host port reachable inside the environment at <env_host>:<env_port> (like ssh -R; e.g. let a phone reach a dev server). UDP needs a dsh-env-server based environment.`,
    parameters: {
      action: { type: 'string', enum: ['open', 'close', 'list'], required: true, description: 'What to do.' },
      direction: { type: 'string', enum: ['to_env', 'from_env'], description: 'Tunnel direction (for open).' },
      env_port: { type: 'integer', description: 'Port inside the environment (0 = pick one, for from_env).' },
      env_host: { type: 'string', description: 'Host inside the environment (default 127.0.0.1).' },
      local_port: { type: 'integer', description: 'Port on the harness host (0 = pick one, for to_env).' },
      protocol: { type: 'string', enum: ['tcp', 'udp'], description: 'Default tcp.' },
      id: { type: 'string', description: 'Tunnel id (for close).' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const describe = t => `${t.id}: ${t.kind === 'forward' ? `host 127.0.0.1:${t.localPort} → env ${t.remoteHost}:${t.remotePort}` : `env ${t.remoteHost}:${t.remotePort} → host ${t.localHost}:${t.localPort}`} (${t.proto})`
      if (args.action === 'list') return env.listTunnels().map(describe).join('\n') || 'No tunnels'
      if (args.action === 'close') {
        const t = env.tunnels.get(args.id)
        if (!t) throw new Error(`unknown tunnel ${args.id}`)
        await t.close()
        return `closed ${args.id}`
      }
      const proto = args.protocol ?? 'tcp'
      if (args.direction === 'from_env') {
        if (!args.local_port) throw new Error('local_port (the host port to expose) is required')
        const t = await env.reverse({ remoteHost: args.env_host ?? '127.0.0.1', remotePort: args.env_port ?? 0, localHost: '127.0.0.1', localPort: args.local_port, proto })
        return `opened ${describe(t)}`
      }
      if (!args.env_port) throw new Error('env_port is required')
      const t = await env.forward({ localHost: '127.0.0.1', localPort: args.local_port ?? 0, remoteHost: args.env_host ?? '127.0.0.1', remotePort: args.env_port, proto })
      return `opened ${describe(t)}`
    },
  })

  if (caps.has('screenshot')) {
    add({
      name: 'screenshot',
      description: `Capture the screen of ${name}. Coordinates in the image map to ${a}__input coordinates (scale them back if the image was downscaled).`,
      parameters: {},
      output: { schema: IMAGE_RESULT_SCHEMA, render: renderImageResult },
      async execute(_args, exec) {
        const shot = await env.screenshot({ signal: exec.signal })
        return imageValue(ctx, exec, shot.png, { name: `${a}-screenshot.png`, text: `Screenshot of ${name}: ${shot.width}x${shot.height} screen pixels.` })
      },
    })
  }

  if (caps.has('input')) {
    add({
      name: 'input',
      description: `Send pointer/keyboard input to ${name}. Actions run in order. Coordinates are screen pixels.${env.kind === 'adb' ? ' On Android, "click" taps, "swipe" drags from (x,y) to (x2,y2), "key" accepts Android key names such as home, back, enter, app_switch.' : ' "key" accepts combos such as "ctrl+s", "alt+tab", "enter".'}`,
      parameters: {
        actions: {
          type: 'array',
          required: true,
          description: 'Actions to perform.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['click', 'move', 'swipe', 'scroll', 'type', 'key', 'wait'], required: true },
              x: { type: 'number' },
              y: { type: 'number' },
              x2: { type: 'number' },
              y2: { type: 'number' },
              button: { type: 'string', enum: ['left', 'right', 'middle'] },
              double: { type: 'boolean' },
              long: { type: 'boolean' },
              dx: { type: 'number' },
              dy: { type: 'number' },
              text: { type: 'string' },
              key: { type: 'string' },
              ms: { type: 'number' },
            },
          },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        await env.input(args.actions, { signal: exec.signal })
        return `performed ${args.actions.length} action${args.actions.length === 1 ? '' : 's'}`
      },
    })
  }

  if (env.kind === 'adb') {
    add({
      name: 'install_apk',
      description: `Install an APK on ${name}. apk_path is read from this session's workspace unless "source" names another borrowed environment alias.`,
      parameters: {
        apk_path: { type: 'string', required: true, description: 'Path of the .apk file.' },
        source: { type: 'string', description: 'Alias of another borrowed environment that holds the file (default: this session\'s workspace).' },
        replace: { type: 'boolean', description: 'Replace an installed app (default true).' },
        downgrade: { type: 'boolean', description: 'Allow version downgrade.' },
      },
      output: TEXT_OUTPUT,
      timeoutMs: 20 * 60 * 1000,
      async execute(args, exec) {
        const { env: srcEnv, cwd: srcCwd, hostPath } = await workspaceOf(exec, args.source, args.apk_path)
        let local = hostPath
        let temp
        if (!local) {
          const p = srcEnv.resolvePath(args.apk_path, srcCwd)
          const data = await srcEnv.readFile(p, { maxBytes: 4 * 1024 * 1024 * 1024, signal: exec.signal })
          temp = path.join(os.tmpdir(), `dsh-apk-${Date.now()}-${baseName(p)}`)
          fs.writeFileSync(temp, data)
          local = temp
        }
        try {
          const text = await env.installApk(local, { replace: args.replace ?? true, downgrade: !!args.downgrade })
          return `Installed ${baseName(args.apk_path)} on ${name}: ${text.split('\n').pop()}`
        } finally {
          if (temp) fs.rmSync(temp, { force: true })
        }
      },
    })

    add({
      name: 'app',
      description: `Manage Android apps on ${name}: launch, stop, clear data, uninstall, show info, or list installed packages.`,
      parameters: {
        action: { type: 'string', enum: ['launch', 'stop', 'clear', 'uninstall', 'info', 'list', 'current'], required: true, description: 'Operation.' },
        package: { type: 'string', description: 'Package name, e.g. com.example.app (filter text for list).' },
        activity: { type: 'string', description: 'Activity to launch (default: the launcher activity).' },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const pkg = args.package
        const need = () => { if (!pkg) throw new Error('package is required') }
        const run = async cmd => {
          const r = await env.exec({ command: cmd }, { signal: exec.signal, timeoutMs: 60000 })
          return `${r.stdout.toString()}${r.stderr.toString()}`.trim()
        }
        switch (args.action) {
          case 'launch':
            need()
            return args.activity
              ? await run(`am start -W -n ${pkg}/${args.activity}`)
              : await run(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 2>&1 | tail -n 2`)
          case 'stop': need(); await run(`am force-stop ${pkg}`); return `stopped ${pkg}`
          case 'clear': need(); return await run(`pm clear ${pkg}`)
          case 'uninstall': need(); return await run(`pm uninstall ${pkg}`)
          case 'info': need(); return clip(await run(`dumpsys package ${pkg} | grep -E 'versionName|versionCode|firstInstallTime|lastUpdateTime|targetSdk|enabled=' | head -n 20`))
          case 'current': return await run(`dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' | head -n 2`)
          case 'list': default: return clip(await run(`pm list packages -3${pkg ? ` | grep -i ${JSON.stringify(pkg)}` : ''}`)) || 'No third-party packages'
        }
      },
    })

    add({
      name: 'ui_dump',
      description: `Describe the current Android UI of ${name}: visible elements with text, resource ids, flags and tap coordinates. Prefer this over screenshots for locating controls.`,
      parameters: { raw: { type: 'boolean', description: 'Return the raw uiautomator XML.' } },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const xml = await env.uiDump({ signal: exec.signal })
        if (!xml.includes('<hierarchy')) throw new Error(`uiautomator dump failed: ${xml.slice(0, 300)}`)
        return clip(args.raw ? xml : compactUiXml(xml) || '(no labelled elements)')
      },
    })

    add({
      name: 'logcat',
      description: `Read recent Android log lines from ${name}.`,
      parameters: {
        lines: { type: 'integer', description: 'Number of recent lines (default 200).' },
        filter: { type: 'string', description: 'Only keep lines containing this text (case-insensitive).' },
        level: { type: 'string', enum: ['V', 'D', 'I', 'W', 'E', 'F'], description: 'Minimum priority (default V).' },
        clear: { type: 'boolean', description: 'Clear the log buffer after reading.' },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const n = Math.min(5000, args.lines ?? 200)
        const r = await env.exec({ command: `logcat -d -v time -t ${args.filter ? 20000 : n} *:${args.level ?? 'V'}` }, { signal: exec.signal, timeoutMs: 60000 })
        let lines = r.stdout.toString().split(/\r?\n/)
        if (args.filter) lines = lines.filter(l => l.toLowerCase().includes(args.filter.toLowerCase())).slice(-n)
        if (args.clear) await env.exec({ command: 'logcat -c' }, { signal: exec.signal })
        return clip(lines.join('\n')) || '(empty)'
      },
    })
  }

  const dispose = async () => {
    for (const mp of processes.values()) await mp.proc.kill().catch(() => {})
    processes.clear()
  }
  return { tools, dispose, processes }
}
