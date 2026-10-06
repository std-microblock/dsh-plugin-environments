// Locating the dsh-env-server binaries that ship with the plugin.
//
// A release package carries one binary per supported target under `bin/<target>/`, either raw
// (`dsh-env-server[.exe]`, local builds) or Brotli-compressed (`dsh-env-server[.exe].br`, release
// packages, to keep the package small). Callers never see the difference: `serverBinaryBytes`
// returns the decompressed executable and `serverBinaryFile` returns a runnable path, unpacking a
// compressed binary into a content-addressed cache directory on first use.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { EnvError } from '@dsh-environments/protocol'
import { binDir, CRATE_TARGET_DIR } from './paths.ts'

/** Targets a release package ships binaries for, named `<node platform>-<node arch>`. */
export const SERVER_TARGETS = ['win32-x64', 'linux-x64', 'linux-ia32', 'linux-arm64', 'darwin-arm64'] as const
export type ServerTarget = (typeof SERVER_TARGETS)[number]

/** The harness host's own target name (may be outside SERVER_TARGETS, e.g. on a dev machine). */
export const HOST_TARGET = `${process.platform}-${process.arch}`

/** Executable file name of the server for a target. */
export function serverExeName(target: string = HOST_TARGET): string {
  return target.startsWith('win32-') ? 'dsh-env-server.exe' : 'dsh-env-server'
}

/**
 * Map what a remote host reports about itself (`uname -s`/`uname -m`, or Windows'
 * `OS`/`PROCESSOR_ARCHITECTURE`) to a shipped target, if any.
 */
export function targetForHost(system: string, machine: string): ServerTarget | undefined {
  const sys = system.trim().toLowerCase()
  const m = machine.trim().toLowerCase()
  const arch = /^(x86_64|amd64|x64)$/.test(m)
    ? 'x64'
    : /^(aarch64|arm64|armv8.*)$/.test(m)
      ? 'arm64'
      : /^(i[3-6]86|x86)$/.test(m)
        ? 'ia32'
        : undefined
  if (!arch) return undefined
  const platform =
    sys === 'linux'
      ? 'linux'
      : sys === 'darwin'
        ? 'darwin'
        : /windows|mingw|msys|cygwin/.test(sys)
          ? 'win32'
          : undefined
  if (!platform) return undefined
  const target = `${platform}-${arch}`
  return (SERVER_TARGETS as readonly string[]).includes(target) ? (target as ServerTarget) : undefined
}

interface Located {
  file: string
  compressed: boolean
}

/**
 * Directory searched for `target`'s binary: `bin/<target>/` in the package, or
 * `$DSH_ENV_SERVER_BIN_DIR/<target>/` when that variable is set (e.g. downloaded CI artifacts).
 */
function targetBinDir(target: string): string {
  const root = process.env['DSH_ENV_SERVER_BIN_DIR']
  return root ? path.join(root, target) : binDir(target)
}

function locate(target: string): Located | undefined {
  const exe = serverExeName(target)
  const dir = targetBinDir(target)
  const raw = path.join(dir, exe)
  if (fs.existsSync(raw)) return { file: raw, compressed: false }
  const br = `${raw}.br`
  if (fs.existsSync(br)) return { file: br, compressed: true }
  if (target === HOST_TARGET) {
    for (const profile of ['release', 'debug']) {
      const built = path.join(CRATE_TARGET_DIR, profile, exe)
      if (fs.existsSync(built)) return { file: built, compressed: false }
    }
  }
  return undefined
}

/** Whether a binary for `target` is available (shipped or built). */
export function hasServerBinary(target: string = HOST_TARGET): boolean {
  return (target === HOST_TARGET && !!process.env['DSH_ENV_SERVER_BIN']) || !!locate(target)
}

/** The decompressed server executable for `target`, or undefined when none ships. */
export function serverBinaryBytes(target: string = HOST_TARGET): Buffer | undefined {
  const override = target === HOST_TARGET ? process.env['DSH_ENV_SERVER_BIN'] : undefined
  if (override && fs.existsSync(override)) return fs.readFileSync(override)
  const found = locate(target)
  if (!found) return undefined
  const data = fs.readFileSync(found.file)
  return found.compressed ? zlib.brotliDecompressSync(data) : data
}

/** Short content hash used to version cached and uploaded binaries. */
export function binaryHash(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16)
}

function cacheRoot(): string {
  const home = process.env['DSH_HOME'] || path.join(os.homedir(), '.dsh')
  return path.join(home, 'cache', 'dsh-plugin-environments', 'bin')
}

/**
 * A runnable path to the server executable for `target` (default: the host). Raw binaries are
 * used in place; a compressed one is unpacked once into `~/.dsh/cache/.../<hash>/`.
 * @throws EnvError ENOENT when no binary is available.
 */
export function serverBinaryFile(target: string = HOST_TARGET, override?: string): string {
  if (override) return override
  const env = target === HOST_TARGET ? process.env['DSH_ENV_SERVER_BIN'] : undefined
  if (env && fs.existsSync(env)) return env
  const found = locate(target)
  if (!found) {
    throw new EnvError('ENOENT', `dsh-env-server binary for ${target} not found in ${targetBinDir(target)}`)
  }
  if (!found.compressed) return found.file
  const data = zlib.brotliDecompressSync(fs.readFileSync(found.file))
  const dir = path.join(cacheRoot(), `${target}-${binaryHash(data)}`)
  const file = path.join(dir, serverExeName(target))
  if (fs.existsSync(file) && fs.statSync(file).size === data.length) return file
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data, { mode: 0o755 })
  try {
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    if (!fs.existsSync(file)) throw e
  }
  return file
}
