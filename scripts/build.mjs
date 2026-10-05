// Build everything: the dsh-env-server binaries (host + Linux x64/arm64 via rust-lld) and client.js.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(ROOT, 'server')
const only = process.argv.includes('--client') ? 'client' : process.argv.includes('--server') ? 'server' : 'all'

function cargo(args, env = {}) {
  console.log(`> cargo ${args.join(' ')}`)
  execFileSync('cargo', args, { cwd: SERVER, stdio: 'inherit', env: { ...process.env, ...env } })
}

function stage(from, dir, name) {
  const dst = path.join(ROOT, 'bin', dir)
  fs.mkdirSync(dst, { recursive: true })
  fs.copyFileSync(from, path.join(dst, name))
  console.log(`staged bin/${dir}/${name}`)
}

if (only !== 'client') {
  cargo(['build', '--release'])
  const hostDir = `${process.platform}-${process.arch}`
  const exe = process.platform === 'win32' ? 'dsh-env-server.exe' : 'dsh-env-server'
  stage(path.join(SERVER, 'target', 'release', exe), hostDir, exe)
  const linux = [['x86_64-unknown-linux-musl', 'linux-x64'], ['aarch64-unknown-linux-musl', 'linux-arm64']]
  for (const [target, dir] of linux) {
    if (dir === hostDir) continue
    const linkerVar = `CARGO_TARGET_${target.toUpperCase().replace(/-/g, '_')}_LINKER`
    try {
      cargo(['build', '--release', '--target', target], { [linkerVar]: process.env[linkerVar] ?? 'rust-lld' })
      stage(path.join(SERVER, 'target', target, 'release', 'dsh-env-server'), dir, 'dsh-env-server')
    } catch (e) {
      console.warn(`skipped ${target}: ${e.message} (rustup target add ${target})`)
    }
  }
}

if (only !== 'server') {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-client.mjs')], { stdio: 'inherit' })
}
