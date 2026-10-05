// FileSystem / SubprocessRuntime providers that route a mounted session into an environment.
// The DSH base classes are injected so this module stays loadable outside the harness (tests).
import { PassThrough } from 'node:stream'
import path from 'node:path'

const FS_CODE = {
  ENOENT: 'FS_NOT_FOUND',
  ENOTDIR: 'FS_NOT_DIRECTORY',
  EACCES: 'FS_PERMISSION_DENIED',
  EPERM: 'FS_PERMISSION_DENIED',
  ETOOBIG: 'FS_TOO_LARGE',
  EISDIR: 'FS_NOT_REGULAR_FILE',
  CANCELLED: 'FS_ABORTED',
}

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })
const DIFF_BASIS_MAX = 2 * 1024 * 1024
const TEXT_MAX = 64 * 1024 * 1024

function normalizeLf(s) {
  return s.replaceAll('\r\n', '\n')
}

function detectCrlf(s) {
  const sample = s.slice(0, 64 * 1024)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf
}

/**
 * Translates between the session's host-side working directory (a placeholder directory or
 * a real local workspace) and the environment's root directory.
 */
export class MountMap {
  constructor({ env, hostRoot, remoteRoot }) {
    this.env = env
    this.hostRoot = hostRoot ? path.resolve(hostRoot) : undefined
    this.remoteRoot = remoteRoot
  }

  hostPrefix(p) {
    if (!this.hostRoot || typeof p !== 'string') return undefined
    const norm = process.platform === 'win32' ? p.replace(/\//g, '\\') : p
    const a = process.platform === 'win32' ? norm.toLowerCase() : norm
    const b = process.platform === 'win32' ? this.hostRoot.toLowerCase() : this.hostRoot
    if (a === b) return ''
    const sep = process.platform === 'win32' ? '\\' : '/'
    if (a.startsWith(b.endsWith(sep) ? b : b + sep)) return norm.slice(this.hostRoot.length).replace(/^[\\/]+/, '')
    return undefined
  }

  /** Map a host path under the placeholder root into the environment; other paths pass through. */
  toRemote(p) {
    const rel = this.hostPrefix(p)
    if (rel === undefined) return p
    if (rel === '') return this.remoteRoot
    return this.env.path.join(this.remoteRoot, ...rel.split(/[\\/]+/))
  }

  resolve(p, cwd) {
    const base = cwd ? this.toRemote(cwd) : this.remoteRoot
    const mapped = this.toRemote(p)
    // Host-absolute paths that are not under the placeholder cannot exist remotely; keep them as-is
    // so the environment reports "not found" instead of silently rewriting them.
    return this.env.resolvePath(mapped, base)
  }
}

function fileUrlOf(env, p) {
  if (env.family === 'windows') return `file:///${p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:')}`
  return `file://${p.split('/').map(encodeURIComponent).join('/')}`
}

/** Create the EnvFileSystem class bound to the harness FileSystem base class. */
export function createEnvFileSystem({ FileSystem, FsError }) {
  const toFsError = (e, display) => {
    if (e instanceof FsError) return e
    const code = FS_CODE[e?.code] ?? 'FS_IO_ERROR'
    return new FsError(`${display ? `${display}: ` : ''}${e?.message ?? e}`, code)
  }
  const version = st => `${Math.round(st.mtimeMs * 1000)}:${st.size}`
  const kind = t => (t === 'dir' ? 'directory' : t === 'file' ? 'file' : 'other')

  return class EnvFileSystem extends FileSystem {
    static inject = []

    constructor(ctx, config) {
      super(ctx)
      this.map = config.map
      this.env = config.map.env
    }

    target(p) {
      return { targetKey: p, displayPath: p }
    }

    async resolve(p, opts = {}) {
      if (typeof p !== 'string' || p.length === 0) throw new FsError('path must be a non-empty string', 'FS_NOT_FOUND')
      return this.target(this.map.resolve(p, opts.cwd))
    }

    processPath(target) {
      return String(target.targetKey)
    }

    processPathFromHostPath(hostPath) {
      return this.map.hostPrefix(hostPath) === undefined ? undefined : this.map.toRemote(hostPath)
    }

    fileUrl(target) {
      return fileUrlOf(this.env, String(target.targetKey))
    }

    contains(parent, child) {
      const P = this.env.path
      const a = String(parent.targetKey)
      const b = String(child.targetKey)
      const norm = s => (this.env.family === 'windows' ? s.toLowerCase() : s)
      if (norm(a) === norm(b)) return true
      const rel = P.relative(a, b)
      return rel !== '' && !rel.startsWith('..') && !P.isAbsolute(rel)
    }

    async stat(target, signal) {
      try {
        const st = await this.env.stat(String(target.targetKey), { signal })
        if (!st) return undefined
        return { version: version(st), type: kind(st.type), ...st.type === 'file' ? { size: st.size } : {} }
      } catch (e) {
        if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return undefined
        throw toFsError(e, target.displayPath)
      }
    }

    async lstat(p, opts = {}, signal) {
      const abs = this.map.resolve(p, opts.cwd)
      try {
        const st = await this.env.stat(abs, { follow: false, signal })
        if (!st) return undefined
        return { version: version(st), type: st.type === 'dir' ? 'directory' : st.type, ...st.type === 'file' ? { size: st.size } : {} }
      } catch (e) {
        if (e?.code === 'ENOENT') return undefined
        throw toFsError(e, abs)
      }
    }

    async readRaw(target, signal, max) {
      try {
        return await this.env.readFile(String(target.targetKey), { signal, maxBytes: max })
      } catch (e) {
        throw toFsError(e, target.displayPath)
      }
    }

    decode(buf, display) {
      if (buf.includes(0)) throw new FsError(`cannot read "${display}": binary file`, 'FS_NOT_TEXT')
      try {
        return TEXT_DECODER.decode(buf)
      } catch {
        throw new FsError(`cannot read "${display}": not valid UTF-8 text`, 'FS_NOT_TEXT')
      }
    }

    async readText(target, signal) {
      const st = await this.stat(target, signal)
      if (!st) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      if (st.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      return this.decode(await this.readRaw(target, signal, TEXT_MAX), target.displayPath)
    }

    async streamText(target, signal) {
      const text = await this.readText(target, signal)
      return (async function* () {
        for (let i = 0; i < text.length; i += 256 * 1024) yield text.slice(i, i + 256 * 1024)
      })()
    }

    async readBytes(target, signal, maxBytes) {
      return new Uint8Array(await this.readRaw(target, signal, maxBytes))
    }

    async readByteRange(target, range, signal) {
      try {
        return new Uint8Array(await this.env.readFile(String(target.targetKey), { offset: range.offset, length: range.length, signal }))
      } catch (e) {
        throw toFsError(e, target.displayPath)
      }
    }

    async listDir(target, signal) {
      let entries
      try {
        entries = await this.env.readdir(String(target.targetKey), { signal })
      } catch (e) {
        throw toFsError(e, target.displayPath)
      }
      const P = this.env.path
      return entries.map(e => ({
        name: e.name,
        type: kind(e.type),
        target: this.target(P.join(String(target.targetKey), e.name)),
        ...e.mtimeMs !== undefined && e.size !== undefined ? { version: version(e) } : {},
        ...e.type === 'file' && e.size !== undefined ? { size: e.size } : {},
      }))
    }

    async current(target, signal) {
      const st = await this.env.stat(String(target.targetKey), { signal }).catch(e => {
        if (e?.code === 'ENOENT') return null
        throw toFsError(e, target.displayPath)
      })
      if (!st) return { exists: false }
      if (st.type !== 'file') throw new FsError(`"${target.displayPath}" is not a regular file`, 'FS_NOT_REGULAR_FILE')
      let text = null
      let crlf = false
      if (st.size <= DIFF_BASIS_MAX) {
        try {
          const raw = this.decode(await this.readRaw(target, signal, DIFF_BASIS_MAX), target.displayPath)
          crlf = detectCrlf(raw)
          text = normalizeLf(raw)
        } catch {}
      }
      return { exists: true, version: version(st), text, crlf }
    }

    async writeText(target, content, expected, signal) {
      const cur = await this.current(target, signal)
      if (expected?.kind === 'createIfAbsent' && cur.exists) {
        throw new FsError(`"${target.displayPath}" already exists; read it before overwriting`, 'FS_NOT_OBSERVED')
      }
      if (expected?.kind === 'replaceIfVersion' && (!cur.exists || cur.version !== expected.version)) {
        throw new FsError(`"${target.displayPath}" changed since it was read; read it again`, 'FS_STALE_VERSION')
      }
      const after = normalizeLf(content)
      const out = cur.crlf ? after.split('\n').join('\r\n') : content
      signal?.throwIfAborted?.()
      let st
      try {
        st = await this.env.writeFile(String(target.targetKey), Buffer.from(out, 'utf8'), { mode: 'overwrite', atomic: true, mkdirs: true, signal })
      } catch (e) {
        throw toFsError(e, target.displayPath)
      }
      return { operation: cur.exists ? 'update' : 'create', version: version(st), before: cur.exists ? cur.text : null, after }
    }

    async editText(target, edit, expected, signal) {
      const st = await this.env.stat(String(target.targetKey), { signal }).catch(() => null)
      if (!st) throw new FsError(`"${target.displayPath}" does not exist`, 'FS_STALE_VERSION')
      if (expected && version(st) !== expected.version) throw new FsError(`"${target.displayPath}" changed since it was read; read it again`, 'FS_STALE_VERSION')
      const raw = this.decode(await this.readRaw(target, signal, TEXT_MAX), target.displayPath)
      const crlf = detectCrlf(raw)
      const before = normalizeLf(raw)
      const oldNorm = normalizeLf(edit.oldString)
      if (oldNorm.length === 0) throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
      const count = before.split(oldNorm).length - 1
      if (count === 0) throw new FsError(`old_string was not found in "${target.displayPath}"`, 'FS_EDIT_NOT_FOUND')
      if (!edit.replaceAll && count > 1) throw new FsError(`old_string matched ${count} times in "${target.displayPath}"; provide a more specific old_string or set replace_all to true`, 'FS_AMBIGUOUS_EDIT')
      const after = before.split(oldNorm).join(normalizeLf(edit.newString))
      const out = crlf ? after.split('\n').join('\r\n') : after
      let written
      try {
        written = await this.env.writeFile(String(target.targetKey), Buffer.from(out, 'utf8'), { mode: 'overwrite', atomic: true, signal })
      } catch (e) {
        throw toFsError(e, target.displayPath)
      }
      return { version: version(written), before, after }
    }
  }
}

/** Tail-keeping collector implementing the offset-based reader contract. */
class Collector {
  constructor(maxBytes) {
    this.maxBytes = maxBytes
    this.chunks = []
    this.size = 0
    this.total = 0
  }

  push(buf) {
    this.chunks.push(buf)
    this.size += buf.length
    this.total += buf.length
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      this.size -= this.chunks.shift().length
    }
  }

  readFrom(fromByte) {
    const start = this.total - this.size
    const all = Buffer.concat(this.chunks)
    if (fromByte < start) return { text: all.toString('utf8'), nextOffset: this.total, lossy: true }
    return { text: all.subarray(fromByte - start).toString('utf8'), nextOffset: this.total, lossy: false }
  }
}

/** Create the EnvSubprocessRuntime class bound to the harness SubprocessRuntime base class. */
export function createEnvSubprocessRuntime({ SubprocessRuntime, SubprocessExecutableNotFoundError }) {
  return class EnvSubprocessRuntime extends SubprocessRuntime {
    static inject = []

    constructor(ctx, config) {
      super(ctx)
      this.map = config.map
      this.env = config.map.env
      this.live = new Set()
      ctx.effect(() => () => {
        for (const p of this.live) p.kill().catch(() => {})
      }, 'environments: mounted processes')
    }

    async resolveExecutable(command, env, signal) {
      if (this.env.path.isAbsolute(command)) {
        const st = await this.env.stat(command, { signal }).catch(() => null)
        if (st?.type === 'file') return command
        throw new SubprocessExecutableNotFoundError(`${command} not found in ${this.env.name}`)
      }
      if (/[\\/]/.test(command)) throw new SubprocessExecutableNotFoundError(`relative executable paths are not supported: ${command}`)
      const probe = this.env.family === 'windows'
        ? { argv: ['where.exe', command] }
        : { argv: ['sh', '-c', `command -v ${JSON.stringify(command)}`] }
      const r = await this.env.exec(probe, { signal }).catch(() => undefined)
      const found = r?.code === 0 ? r.stdout.toString().split(/\r?\n/).map(s => s.trim()).find(Boolean) : undefined
      if (!found) throw new SubprocessExecutableNotFoundError(`${command} not found in ${this.env.name}`)
      return found
    }

    async terminalEnvironment() {
      return { platform: this.env.family === 'windows' ? 'windows' : 'posix', defaultShell: this.env.info?.shell || undefined }
    }

    spawnSpec(spec) {
      const env = {}
      for (const [k, v] of Object.entries(spec.env ?? {})) env[k] = v === undefined ? null : String(v)
      return { argv: [...spec.argv], cwd: this.map.toRemote(spec.cwd), env }
    }

    spawn(spec) {
      if (spec.signal?.aborted) throw new Error('spawn aborted')
      const stdinMode = spec.stdio.stdin
      const stdin = stdinMode === 'pipe' ? new PassThrough() : undefined
      const pipes = {}
      const collected = {}
      for (const name of ['stdout', 'stderr']) {
        const mode = spec.stdio[name]
        if (mode === 'pipe') pipes[name] = new PassThrough()
        else if (mode && typeof mode === 'object') collected[name] = new Collector(mode.maxBytes)
      }
      let proc
      let terminated = false
      let resolveDone
      let rejectDone
      const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej })
      done.catch(() => {})
      const self = this
      const handle = {
        stdin,
        stdout: pipes.stdout,
        stderr: pipes.stderr,
        control: undefined,
        collected: Object.fromEntries(Object.entries(collected).map(([k, c]) => [k, { readFrom: n => c.readFrom(n) }])),
        done,
        terminate() {
          terminated = true
          proc?.kill().catch(() => {})
        },
        async waitForExit(signal) {
          if (!proc) await new Promise(r => setTimeout(r, 10))
          const aborted = new Promise(r => signal?.addEventListener('abort', () => r(false), { once: true }))
          return Promise.race([done.then(() => true, () => true), aborted])
        },
      }
      spec.signal?.addEventListener('abort', () => handle.terminate(), { once: true })
      this.env.spawn(this.spawnSpec(spec)).then(p => {
        proc = p
        self.live.add(p)
        if (terminated) p.kill().catch(() => {})
        const outputs = []
        for (const name of ['stdout', 'stderr']) {
          const src = p[name]
          if (!src) continue
          const ended = new Promise(r => { src.once('end', r); src.once('close', r); src.once('error', r) })
          outputs.push(ended)
          if (pipes[name]) src.pipe(pipes[name])
          else if (collected[name]) src.on('data', d => collected[name].push(d))
          else src.resume()
        }
        if (stdin) {
          stdin.on('data', d => { stdin.pause(); p.write(d).then(() => stdin.resume(), () => stdin.resume()) })
          stdin.on('end', () => p.end())
        } else if (stdinMode && typeof stdinMode === 'object') {
          p.write(Buffer.from(stdinMode.data)).finally(() => p.end())
        } else {
          p.end()
        }
        p.exited.then(async exit => {
          self.live.delete(p)
          await Promise.race([Promise.all(outputs), new Promise(r => setTimeout(r, Math.min(spec.graceMs ?? 2000, 5000)))])
          for (const name of ['stdout', 'stderr']) if (pipes[name] && !pipes[name].writableEnded) pipes[name].end()
          const signal = exit.code === null ? (exit.signal && /^SIG/.test(exit.signal) ? exit.signal : 'SIGKILL') : null
          resolveDone({ exitCode: exit.code, signal })
        })
      }, error => {
        for (const s of Object.values(pipes)) s.destroy(error)
        rejectDone(error)
      })
      return handle
    }

    async spawnTerminal(spec) {
      const env = {}
      for (const [k, v] of Object.entries(spec.env ?? {})) env[k] = String(v)
      env.TERM = spec.terminalType
      const p = await this.env.spawn({ argv: [...spec.argv], cwd: this.map.toRemote(spec.cwd), env, pty: { rows: spec.rows, cols: spec.cols } }, { signal: spec.signal })
      this.live.add(p)
      const output = new PassThrough()
      p.stdout.pipe(output)
      const done = p.exited.then(exit => {
        this.live.delete(p)
        return { exitCode: exit.code, signal: exit.code === null ? 'SIGKILL' : null }
      })
      let revision = 0
      return {
        pid: p.pid ?? 0,
        output,
        done,
        async write(data) { revision++; await p.write(Buffer.from(data, 'utf8')) },
        async resize(cols, rows) { await p.resize(rows, cols) },
        async inspectForeground() { return undefined },
        async inspectActivity() { return { state: 'unknown', revision } },
        async signalForeground(signal) {
          if (signal === 'SIGINT') await p.write(Buffer.from('\x03'))
          else await p.kill()
          return p.pid ?? 0
        },
        async terminate() { await p.kill(); await done.catch(() => {}) },
      }
    }
  }
}
