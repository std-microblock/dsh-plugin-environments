// Build everything: the dsh-env-server binaries (host + Linux x64/arm64 via rust-lld), the
// plugin bundle (packages/plugin/dist) and the GUI client (packages/plugin/client.js).
//
//   node scripts/build.ts [--server] [--plugin] [--client]   (no flag = all)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClient } from './build-client.ts'
import { buildPlugin } from './build-plugin.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CRATE = path.join(ROOT, 'crates', 'dsh-env-server')
const PLUGIN_BIN = path.join(ROOT, 'packages', 'plugin', 'bin')

const flags = new Set(process.argv.slice(2))
const all = !['--server', '--plugin', '--client'].some(f => flags.has(f))

function cargo(args: string[], env: Record<string, string> = {}): void {
  console.log(`> cargo ${args.join(' ')}`)
  execFileSync('cargo', args, { cwd: CRATE, stdio: 'inherit', env: { ...process.env, ...env } })
}

function stage(from: string, dir: string, name: string): void {
  const dst = path.join(PLUGIN_BIN, dir)
  fs.mkdirSync(dst, { recursive: true })
  fs.copyFileSync(from, path.join(dst, name))
  console.log(`staged packages/plugin/bin/${dir}/${name}`)
}

function buildServer(): void {
  cargo(['build', '--release'])
  const hostDir = `${process.platform}-${process.arch}`
  const exe = process.platform === 'win32' ? 'dsh-env-server.exe' : 'dsh-env-server'
  stage(path.join(CRATE, 'target', 'release', exe), hostDir, exe)
  const linux = [
    ['x86_64-unknown-linux-musl', 'linux-x64'],
    ['aarch64-unknown-linux-musl', 'linux-arm64'],
  ] as const
  for (const [target, dir] of linux) {
    if (dir === hostDir) continue
    const linkerVar = `CARGO_TARGET_${target.toUpperCase().replace(/-/g, '_')}_LINKER`
    try {
      cargo(['build', '--release', '--target', target], { [linkerVar]: process.env[linkerVar] ?? 'rust-lld' })
      stage(path.join(CRATE, 'target', target, 'release', 'dsh-env-server'), dir, 'dsh-env-server')
    } catch (e) {
      console.warn(`skipped ${target}: ${e instanceof Error ? e.message : String(e)} (rustup target add ${target})`)
    }
  }
}

if (all || flags.has('--server')) buildServer()
if (all || flags.has('--plugin')) await buildPlugin({ root: ROOT })
if (all || flags.has('--client')) await buildClient({ root: ROOT, minify: flags.has('--minify') })
