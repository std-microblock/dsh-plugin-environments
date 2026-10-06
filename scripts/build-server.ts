// Build dsh-env-server for one or more targets and stage the binaries as
// `<out>/<target>/dsh-env-server[.exe]` (default out: packages/plugin/bin).
//
//   node scripts/build-server.ts [--target <t>[,<t>]]... [--all] [--dist] [--fallback]
//                                [--toolchain <name>] [--out <dir>]
//
// Targets are package names (`linux-x64`) or Rust triples. Without --target / --all it builds the
// host plus the Linux musl targets and skips (with a warning) any whose toolchain is missing; with
// explicit targets every failure is fatal.
//
// --dist builds the smaller nightly `cargo dist` profile with the toolchain pinned in
// scripts/dist-toolchain.txt (see docs/building-server.md). With --fallback a failing nightly
// build falls back to the stable `--release` build (with a warning) instead of failing.
//
// No npm dependencies, so CI can run it right after setup-node.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { CRATE, distToolchain, HOST_TARGET, PLUGIN_DIR, SERVER_TARGETS, targetInfo } from './server-targets.ts'
import type { ServerTargetInfo } from './server-targets.ts'

export interface BuildServerOptions {
  targets?: readonly string[]
  dist?: boolean
  fallback?: boolean
  toolchain?: string
  out?: string
}

function warn(message: string): void {
  console.warn(process.env['GITHUB_ACTIONS'] ? `::warning::${message}` : `warning: ${message}`)
}

function cargo(args: string[], env: Record<string, string>): void {
  console.log(`> cargo ${args.join(' ')}`)
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env }
  // RUSTFLAGS overrides build.rustflags and would silently drop -Cpanic=immediate-abort.
  delete childEnv['RUSTFLAGS']
  execFileSync('cargo', args, { cwd: CRATE, stdio: 'inherit', env: childEnv })
}

function linkerEnv(info: ServerTargetInfo): Record<string, string> {
  if (!info.lld) return {}
  const name = `CARGO_TARGET_${info.triple.toUpperCase().replace(/-/g, '_')}_LINKER`
  return { [name]: process.env[name] ?? 'rust-lld' }
}

function buildOne(info: ServerTargetInfo, opts: BuildServerOptions): string {
  const env = linkerEnv(info)
  if (opts.dist) {
    const toolchain = opts.toolchain ?? distToolchain()
    try {
      cargo([`+${toolchain}`, 'dist', '--locked', '--target', info.triple], env)
      return path.join(CRATE, 'target', info.triple, 'dist', info.exe)
    } catch (e) {
      if (!opts.fallback) {
        throw new Error(
          `nightly dist build for ${info.target} failed with ${toolchain} ` +
            `(rustup toolchain install ${toolchain} --profile minimal -c rust-src -t ${info.triple}): ` +
            (e instanceof Error ? e.message : String(e)),
          { cause: e },
        )
      }
      warn(`nightly dist build for ${info.target} failed with ${toolchain}; falling back to stable --release`)
    }
  }
  cargo(['build', '--release', '--locked', '--target', info.triple], env)
  return path.join(CRATE, 'target', info.triple, 'release', info.exe)
}

export function buildServer(opts: BuildServerOptions = {}): string[] {
  const explicit = !!opts.targets && opts.targets.length > 0
  const infos = explicit
    ? (opts.targets ?? []).map(targetInfo)
    : SERVER_TARGETS.filter(t => t.target === HOST_TARGET || t.lld)
  const out = path.resolve(opts.out ?? path.join(PLUGIN_DIR, 'bin'))
  const staged: string[] = []
  for (const info of infos) {
    let built: string
    try {
      built = buildOne(info, opts)
    } catch (e) {
      if (explicit) throw e
      warn(`skipped ${info.target}: ${e instanceof Error ? e.message : String(e)} (rustup target add ${info.triple})`)
      continue
    }
    const dir = path.join(out, info.target)
    fs.mkdirSync(dir, { recursive: true })
    const dst = path.join(dir, info.exe)
    fs.copyFileSync(built, dst)
    fs.chmodSync(dst, 0o755)
    console.log(`staged ${path.relative(process.cwd(), dst)} (${(fs.statSync(dst).size / 1024).toFixed(0)} KiB)`)
    staged.push(dst)
  }
  return staged
}

if (import.meta.main) {
  const { values } = parseArgs({
    // pnpm run x -- --flag forwards the --; drop it so the flags still parse.
    args: process.argv.slice(2).filter(a => a !== '--'),
    options: {
      target: { type: 'string', multiple: true },
      all: { type: 'boolean' },
      dist: { type: 'boolean' },
      fallback: { type: 'boolean' },
      toolchain: { type: 'string' },
      out: { type: 'string' },
    },
  })
  const targets = values.all
    ? SERVER_TARGETS.map(t => t.target)
    : (values.target ?? []).flatMap(t => t.split(',')).filter(Boolean)
  const opts: BuildServerOptions = { targets, dist: !!values.dist, fallback: !!values.fallback }
  if (values.toolchain) opts.toolchain = values.toolchain
  if (values.out) opts.out = values.out
  buildServer(opts)
}
