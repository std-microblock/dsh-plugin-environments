// FileSystem provider that routes a mounted session's file tools into an environment.
// The DSH base classes are injected so this module stays loadable outside the harness (tests).
import type { Context } from '@deepseek-ai/cordis'
import type {
  FileSystem as FileSystemBase,
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsError as FsErrorClass,
  FsErrorCode,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsTargetKey,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { errorCode, errorMessage, type Stat } from '@dsh-environments/protocol'
import type { Environment } from '../env/environment.ts'
import type { MountMap } from './map.ts'

const FS_CODE: Record<string, FsErrorCode> = {
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

export function normalizeLf(s: string): string {
  return s.replaceAll('\r\n', '\n')
}

/** True when CRLF line endings dominate the first 64 KiB. */
export function detectCrlf(s: string): boolean {
  const sample = s.slice(0, 64 * 1024)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf
}

function fileUrlOf(env: Environment, p: string): string {
  if (env.family === 'windows') {
    return `file:///${p
      .replace(/\\/g, '/')
      .split('/')
      .map(encodeURIComponent)
      .join('/')
      .replace(/^([A-Za-z])%3A/, '$1:')}`
  }
  return `file://${p.split('/').map(encodeURIComponent).join('/')}`
}

export interface EnvFileSystemConfig {
  map: MountMap
}

/** Base classes of the harness filesystem seam. */
export interface FileSystemDeps {
  FileSystem: typeof FileSystemBase
  FsError: typeof FsErrorClass
}

/** Opaque version token: mtime (µs) and size. */
const versionOf = (st: { mtimeMs?: number | undefined; size?: number | undefined }) =>
  `${Math.round((st.mtimeMs ?? NaN) * 1000)}:${st.size}` as FsVersion
const kindOf = (t: Stat['type']): FsInfo['type'] => (t === 'dir' ? 'directory' : t === 'file' ? 'file' : 'other')
const keyOf = (target: FsTarget) => String(target.targetKey)

interface CurrentText {
  exists: boolean
  version?: FsVersion
  text?: string | null
  crlf?: boolean
}

/** Create the EnvFileSystem class bound to the harness FileSystem base class. */
export function createEnvFileSystem({ FileSystem, FsError }: FileSystemDeps) {
  const toFsError = (e: unknown, display?: string) => {
    if (e instanceof FsError) return e
    const code = FS_CODE[errorCode(e) ?? ''] ?? 'FS_IO_ERROR'
    return new FsError(`${display ? `${display}: ` : ''}${errorMessage(e)}`, code)
  }

  return class EnvFileSystem extends FileSystem {
    static inject = []
    readonly map: MountMap
    readonly env: Environment

    constructor(ctx: Context, config: EnvFileSystemConfig) {
      super(ctx)
      this.map = config.map
      this.env = config.map.env
    }

    target(p: string): FsTarget {
      return { targetKey: p as FsTargetKey, displayPath: p }
    }

    resolve(p: string, opts: { cwd?: string; signal?: AbortSignal } = {}): Promise<FsTarget> {
      if (typeof p !== 'string' || p.length === 0) {
        return Promise.reject(new FsError('path must be a non-empty string', 'FS_NOT_FOUND'))
      }
      return Promise.resolve(this.target(this.map.resolve(p, opts.cwd)))
    }

    processPath(target: FsTarget): string {
      return keyOf(target)
    }

    override processPathFromHostPath(hostPath: string): string | undefined {
      return this.map.hostPrefix(hostPath) === undefined ? undefined : this.map.toRemote(hostPath)
    }

    fileUrl(target: FsTarget): string {
      return fileUrlOf(this.env, keyOf(target))
    }

    contains(parent: FsTarget, child: FsTarget): boolean {
      const P = this.env.path
      const a = keyOf(parent)
      const b = keyOf(child)
      const norm = (s: string) => (this.env.family === 'windows' ? s.toLowerCase() : s)
      if (norm(a) === norm(b)) return true
      const rel = P.relative(a, b)
      return rel !== '' && !rel.startsWith('..') && !P.isAbsolute(rel)
    }

    async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
      try {
        const st = await this.env.stat(keyOf(target), { signal })
        if (!st) return undefined
        return { version: versionOf(st), type: kindOf(st.type), ...(st.type === 'file' ? { size: st.size } : {}) }
      } catch (e) {
        const code = errorCode(e)
        if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
        throw toFsError(e, target.displayPath)
      }
    }

    async lstat(p: string, opts: { cwd?: string } = {}, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
      const abs = this.map.resolve(p, opts.cwd)
      try {
        const st = await this.env.stat(abs, { follow: false, signal })
        if (!st) return undefined
        return {
          version: versionOf(st),
          type: st.type === 'dir' ? 'directory' : st.type,
          ...(st.type === 'file' ? { size: st.size } : {}),
        }
      } catch (e) {
        if (errorCode(e) === 'ENOENT') return undefined
        throw toFsError(e, abs)
      }
    }

    private async readRaw(target: FsTarget, signal: AbortSignal | undefined, max: number | undefined): Promise<Buffer> {
      try {
        return await this.env.readFile(keyOf(target), { signal, ...(max !== undefined ? { maxBytes: max } : {}) })
      } catch (e) {
        throw toFsError(e, target.displayPath)
      }
    }

    private decode(buf: Buffer, display: string): string {
      if (buf.includes(0)) throw new FsError(`cannot read "${display}": binary file`, 'FS_NOT_TEXT')
      try {
        return TEXT_DECODER.decode(buf)
      } catch {
        throw new FsError(`cannot read "${display}": not valid UTF-8 text`, 'FS_NOT_TEXT')
      }
    }

    async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
      const st = await this.stat(target, signal)
      if (!st) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      if (st.type !== 'file') {
        throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      return this.decode(await this.readRaw(target, signal, TEXT_MAX), target.displayPath)
    }

    async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
      const text = await this.readText(target, signal)
      return (async function* () {
        for (let i = 0; i < text.length; i += 256 * 1024) yield text.slice(i, i + 256 * 1024)
      })()
    }

    async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
      return new Uint8Array(await this.readRaw(target, signal, maxBytes))
    }

    async readByteRange(
      target: FsTarget,
      range: { offset: number; length: number },
      signal?: AbortSignal,
    ): Promise<Uint8Array> {
      try {
        return new Uint8Array(
          await this.env.readFile(keyOf(target), { offset: range.offset, length: range.length, signal }),
        )
      } catch (e) {
        throw toFsError(e, target.displayPath)
      }
    }

    async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
      let entries
      try {
        entries = await this.env.readdir(keyOf(target), { signal })
      } catch (e) {
        throw toFsError(e, target.displayPath)
      }
      const P = this.env.path
      return entries.map(e => ({
        name: e.name,
        type: kindOf(e.type),
        target: this.target(P.join(keyOf(target), e.name)),
        ...(e.mtimeMs !== undefined && e.size !== undefined ? { version: versionOf(e) } : {}),
        ...(e.type === 'file' && e.size !== undefined ? { size: e.size } : {}),
      }))
    }

    /** Current state of a file as the diff basis for writes. */
    private async current(target: FsTarget, signal?: AbortSignal): Promise<CurrentText> {
      const st = await this.env.stat(keyOf(target), { signal }).catch((e: unknown) => {
        if (errorCode(e) === 'ENOENT') return null
        throw toFsError(e, target.displayPath)
      })
      if (!st) return { exists: false }
      if (st.type !== 'file') throw new FsError(`"${target.displayPath}" is not a regular file`, 'FS_NOT_REGULAR_FILE')
      let text: string | null = null
      let crlf = false
      if (st.size <= DIFF_BASIS_MAX) {
        try {
          const raw = this.decode(await this.readRaw(target, signal, DIFF_BASIS_MAX), target.displayPath)
          crlf = detectCrlf(raw)
          text = normalizeLf(raw)
        } catch {
          // binary or unreadable: no diff basis
        }
      }
      return { exists: true, version: versionOf(st), text, crlf }
    }

    async writeText(
      target: FsTarget,
      content: string,
      expected?: FsWriteIntent,
      signal?: AbortSignal,
    ): Promise<FsWriteOutcome> {
      const cur = await this.current(target, signal)
      if (expected?.kind === 'createIfAbsent' && cur.exists) {
        throw new FsError(`"${target.displayPath}" already exists; read it before overwriting`, 'FS_NOT_OBSERVED')
      }
      if (expected?.kind === 'replaceIfVersion' && (!cur.exists || cur.version !== expected.version)) {
        throw new FsError(`"${target.displayPath}" changed since it was read; read it again`, 'FS_STALE_VERSION')
      }
      const after = normalizeLf(content)
      const out = cur.crlf ? after.split('\n').join('\r\n') : content
      signal?.throwIfAborted()
      let st
      try {
        st = await this.env.writeFile(keyOf(target), Buffer.from(out, 'utf8'), {
          mode: 'overwrite',
          atomic: true,
          mkdirs: true,
          signal,
        })
      } catch (e) {
        throw toFsError(e, target.displayPath)
      }
      return {
        operation: cur.exists ? 'update' : 'create',
        version: versionOf(st ?? {}),
        before: cur.exists ? (cur.text ?? null) : null,
        after,
      }
    }

    async editText(
      target: FsTarget,
      edit: FsEditRequest,
      expected?: { version: FsVersion },
      signal?: AbortSignal,
    ): Promise<FsEditOutcome> {
      const st = await this.env.stat(keyOf(target), { signal }).catch(() => null)
      if (!st) throw new FsError(`"${target.displayPath}" does not exist`, 'FS_STALE_VERSION')
      if (expected && versionOf(st) !== expected.version) {
        throw new FsError(`"${target.displayPath}" changed since it was read; read it again`, 'FS_STALE_VERSION')
      }
      const raw = this.decode(await this.readRaw(target, signal, TEXT_MAX), target.displayPath)
      const crlf = detectCrlf(raw)
      const before = normalizeLf(raw)
      const oldNorm = normalizeLf(edit.oldString)
      if (oldNorm.length === 0) throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
      const count = before.split(oldNorm).length - 1
      if (count === 0) throw new FsError(`old_string was not found in "${target.displayPath}"`, 'FS_EDIT_NOT_FOUND')
      if (!edit.replaceAll && count > 1) {
        throw new FsError(
          `old_string matched ${count} times in "${target.displayPath}"; provide a more specific old_string or set replace_all to true`,
          'FS_AMBIGUOUS_EDIT',
        )
      }
      const after = before.split(oldNorm).join(normalizeLf(edit.newString))
      const out = crlf ? after.split('\n').join('\r\n') : after
      let written
      try {
        written = await this.env.writeFile(keyOf(target), Buffer.from(out, 'utf8'), {
          mode: 'overwrite',
          atomic: true,
          signal,
        })
      } catch (e) {
        throw toFsError(e, target.displayPath)
      }
      return { version: versionOf(written ?? {}), before, after }
    }
  }
}

export type EnvFileSystem = InstanceType<ReturnType<typeof createEnvFileSystem>>
