// Minimal Environment-compatible adapter over the harness host filesystem, used as the
// "workspace" side of transfers for sessions that are not mounted.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Environment } from './env/environment.js'
import { EnvError } from './protocol/client.js'

function wrap(e, p) {
  return new EnvError(e?.code ?? 'EIO', `${p}: ${e?.message ?? e}`)
}

function statOf(st) {
  return { type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'symlink' : 'other', size: st.size, mtimeMs: st.mtimeMs, mode: st.mode & 0o7777 }
}

export class HostEnvironment extends Environment {
  constructor(cwd) {
    super({ id: 'host', name: 'workspace', kind: 'host' })
    this.info = {
      os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform,
      family: process.platform === 'win32' ? 'windows' : 'posix',
      cwd, home: '', pathSep: path.sep, caps: ['fs'],
    }
  }

  async stat(p, opts = {}) {
    try {
      return statOf(opts.follow === false ? await fsp.lstat(p) : await fsp.stat(p))
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
      throw wrap(e, p)
    }
  }

  async readdir(p) {
    try {
      const entries = await fsp.readdir(p, { withFileTypes: true })
      const out = []
      for (const e of entries) {
        let st
        try { st = await fsp.stat(path.join(p, e.name)) } catch {}
        out.push({ name: e.name, type: st ? statOf(st).type : 'other', size: st?.size, mtimeMs: st?.mtimeMs })
      }
      return out.sort((a, b) => (a.name < b.name ? -1 : 1))
    } catch (e) {
      throw wrap(e, p)
    }
  }

  async readFile(p, opts = {}) {
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

  async writeFile(p, data, opts = {}) {
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

  async mkdir(p, opts = {}) {
    try { await fsp.mkdir(p, { recursive: !!opts.recursive }) } catch (e) { throw wrap(e, p) }
  }

  async remove(p, opts = {}) {
    try { await fsp.rm(p, { recursive: !!opts.recursive }) } catch (e) { throw wrap(e, p) }
  }

  async rename(a, b) {
    try { await fsp.rename(a, b) } catch (e) { throw wrap(e, a) }
  }

  async openRead(p) {
    return fs.createReadStream(p)
  }
}
