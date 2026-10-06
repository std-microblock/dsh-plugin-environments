// The dsh-env-server targets a release package ships, shared by the build and package scripts.
// Keep in sync with SERVER_TARGETS in packages/plugin/src/server-binary.ts (checked by
// packages/plugin/test/server-binary.test.ts).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CRATE = path.join(ROOT, 'crates', 'dsh-env-server')
export const PLUGIN_DIR = path.join(ROOT, 'packages', 'plugin')

export interface ServerTargetInfo {
  /** Package directory name, `<node platform>-<node arch>`. */
  target: string
  /** Rust target triple. */
  triple: string
  /** Executable file name. */
  exe: string
  /** Linked with the bundled rust-lld (static musl) so it builds on any host. */
  lld: boolean
}

export const SERVER_TARGETS: readonly ServerTargetInfo[] = [
  { target: 'win32-x64', triple: 'x86_64-pc-windows-msvc', exe: 'dsh-env-server.exe', lld: false },
  { target: 'linux-x64', triple: 'x86_64-unknown-linux-musl', exe: 'dsh-env-server', lld: true },
  { target: 'linux-ia32', triple: 'i686-unknown-linux-musl', exe: 'dsh-env-server', lld: true },
  { target: 'linux-arm64', triple: 'aarch64-unknown-linux-musl', exe: 'dsh-env-server', lld: true },
  { target: 'darwin-arm64', triple: 'aarch64-apple-darwin', exe: 'dsh-env-server', lld: false },
]

export const HOST_TARGET = `${process.platform}-${process.arch}`

export function targetInfo(name: string): ServerTargetInfo {
  const info = SERVER_TARGETS.find(t => t.target === name || t.triple === name)
  if (!info) {
    throw new Error(`unknown target ${name} (known: ${SERVER_TARGETS.map(t => t.target).join(', ')})`)
  }
  return info
}

/** The pinned nightly toolchain used for the size-optimised `cargo dist` build. */
export function distToolchain(): string {
  const file = path.join(ROOT, 'scripts', 'dist-toolchain.txt')
  const value = fs.readFileSync(file, 'utf8').trim()
  if (!/^nightly-\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${file}: expected nightly-YYYY-MM-DD`)
  return value
}
