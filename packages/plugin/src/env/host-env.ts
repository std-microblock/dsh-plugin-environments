// Minimal Environment over the harness host filesystem, used as the "workspace" side of
// transfers for sessions that are not mounted.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { EnvError, errorCode, errorMessage, type DirEntry, type Stat } from '@dsh-environments/protocol'
import { Environment } from './environment.ts'
import type { ReadFileOptions, RecursiveOptions, StatOptions, WriteFileOptions } from './types.ts'

function wrap(e: unknown, p: string): EnvError {
  return new EnvError(errorCode(e) ?? 'EIO', `${p}: ${errorMessage(e)}`)
}

function statOf(st: fs.Stats): Stat {
  return {
    type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'symlink' : 'other',
    size: st.size,
    mtimeMs: st.mtimeMs,
    mode: st.mode & 0o7777,
  }
}

export class HostEnvironment extends Environment {
  constructor(cwd: string) {
    super({ id: 'host', name: 'workspace', kind: 'host' })
    const windows = process.platform === 'win32'
    this.info = {
      os: windows ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform,
      family: windows ? 'windows' : 'posix',
      arch: '',
      hostname: '',
      user: '',
      cwd,
      home: '',
      pathSep: path.sep,
      shell: '',
      caps: ['fs'],
      version: '',
    }
  }

  override async stat(p: string, opts: StatOptions = {}): Promise<Stat | null> {
    try {
      return statOf(opts.follow === false ? await fsp.lstat(p) : await fsp.stat(p))
    } catch (e) {
      const code = errorCode(e)
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw wrap(e, p)
    }
  }

  override async readdir(p: string): Promise<DirEntry[]> {
    try {
      const entries = await fsp.readdir(p, { withFileTypes: true })
      const out: DirEntry[] = []
      for (const e of entries) {
        let st: fs.Stats | undefined
        try {
          st = await fsp.stat(path.join(p, e.name))
        } catch {
          // dangling entry
        }
        out.push({ name: e.name, type: st ? statOf(st).type : 'other', size: st?.size, mtimeMs: st?.mtimeMs })
      }
      return out.sort((a, b) => (a.name < b.name ? -1 : 1))
    } catch (e) {
      throw wrap(e, p)
    }
  }

  override async readFile(p: string, opts: ReadFileOptions = {}): Promise<Buffer> {
    try {
      if (opts.offset !== undefined || opts.length !== undefined) {
        const fh = await fsp.open(p, 'r')
        try {
          const st = await fh.stat()
          const len = Math.max(0, Math.min(opts.length ?? st.size, st.size - (opts.offset ?? 0)))
          const buf = Buffer.alloc(len)
          await fh.read(buf, 0, len, opts.offset ?? 0)
          return buf
        } finally {
          await fh.close()
        }
      }
      const st = await fsp.stat(p)
      const max = opts.maxBytes ?? opts.max
      if (max !== undefined && st.size > max) throw new EnvError('ETOOBIG', `${p} is ${st.size} bytes (limit ${max})`)
      return await fsp.readFile(p)
    } catch (e) {
      if (e instanceof EnvError) throw e
      throw wrap(e, p)
    }
  }

  override async writeFile(p: string, data: Uint8Array | string, opts: WriteFileOptions = {}): Promise<Stat> {
    try {
      if (opts.mkdirs) await fsp.mkdir(path.dirname(p), { recursive: true })
      if (opts.mode === 'create' && fs.existsSync(p)) throw new EnvError('EEXIST', `already exists: ${p}`)
      if (opts.mode === 'append') await fsp.appendFile(p, data)
      else {
        const tmp = path.join(path.dirname(p), `.${path.basename(p)}.dsh-tmp-${Date.now()}`)
        await fsp.writeFile(tmp, data)
        await fsp.rename(tmp, p)
      }
      return statOf(await fsp.stat(p))
    } catch (e) {
      if (e instanceof EnvError) throw e
      throw wrap(e, p)
    }
  }

  override async mkdir(p: string, opts: RecursiveOptions = {}): Promise<void> {
    try {
      await fsp.mkdir(p, { recursive: !!opts.recursive })
    } catch (e) {
      throw wrap(e, p)
    }
  }

  override async remove(p: string, opts: RecursiveOptions = {}): Promise<void> {
    try {
      await fsp.rm(p, { recursive: !!opts.recursive })
    } catch (e) {
      throw wrap(e, p)
    }
  }

  override async rename(a: string, b: string): Promise<void> {
    try {
      await fsp.rename(a, b)
    } catch (e) {
      throw wrap(e, a)
    }
  }

  openRead(p: string): Promise<Readable> {
    return Promise.resolve(fs.createReadStream(p))
  }
}
