// Assemble the publishable plugin package and the release assets.
//
//   node scripts/package.ts [--allow-missing] [--no-build] [--bin-dir <dir>] [--out <dir>]
//
// Output (default `out/`):
//   dsh-plugin-environments-<version>.tgz          the plugin package (`pnpm pack`)
//   dsh-env-server-<version>-<target>[.exe].gz     raw server binaries, one per target
//   SHA256SUMS                                     sha256 of all of the above
//
// The package contains dist/, client.js, cordis.patch.yml, README.md, LICENSE and
// bin/<target>/dsh-env-server[.exe].br for every shipped target (Brotli quality 11, 16 MiB window;
// packages/plugin/src/server-binary.ts unpacks them on demand). Binaries are taken from
// `--bin-dir/<target>/` (default packages/plugin/bin, as staged by scripts/build-server.ts), raw or
// already compressed. A missing target is an error unless --allow-missing is given (local use:
// darwin-arm64 cannot be linked off macOS).
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import zlib from 'node:zlib'
import { buildClient } from './build-client.ts'
import { buildPlugin } from './build-plugin.ts'
import { HOST_TARGET, PLUGIN_DIR, ROOT, SERVER_TARGETS } from './server-targets.ts'

const { values } = parseArgs({
  // pnpm run x -- --flag forwards the --; drop it so the flags still parse.
  args: process.argv.slice(2).filter(a => a !== '--'),
  options: {
    'allow-missing': { type: 'boolean' },
    'no-build': { type: 'boolean' },
    'bin-dir': { type: 'string' },
    out: { type: 'string' },
  },
})

const OUT = path.resolve(values.out ?? path.join(ROOT, 'out'))
const BIN_DIR = path.resolve(values['bin-dir'] ?? path.join(PLUGIN_DIR, 'bin'))
const STAGE = path.join(OUT, '.stage')
const REPO = 'std-microblock/dsh-plugin-environments'

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
type Manifest = { [key: string]: Json }

class PackageError extends Error {}

function fail(message: string): never {
  throw new PackageError(message)
}

function kib(n: number): string {
  return `${(n / 1024).toFixed(0)} KiB`
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function brotli(data: Buffer): Buffer {
  return zlib.brotliCompressSync(data, {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC,
      [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
      [zlib.constants.BROTLI_PARAM_LGWIN]: zlib.constants.BROTLI_MAX_WINDOW_BITS,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  })
}

function isObject(v: Json | undefined): v is { [key: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The manifest that ships: no scripts, devDependencies or workspace-only fields. */
function publishedManifest(source: Manifest): Manifest {
  const out: Manifest = { ...source }
  for (const key of ['private', 'scripts', 'devDependencies', 'publishConfig', 'packageManager', 'pnpm']) {
    delete out[key]
  }
  const errors: string[] = []
  for (const key of ['name', 'version', 'license', 'repository', 'main', 'files']) {
    if (out[key] === undefined) errors.push(`packages/plugin/package.json: missing "${key}"`)
  }
  const version = out['version']
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    errors.push(`packages/plugin/package.json: version ${JSON.stringify(version)} is not semver`)
  }
  for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = out[key]
    if (!isObject(deps)) continue
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || /^(workspace|link|file|portal):/.test(spec)) {
        errors.push(`${key}.${name}: ${JSON.stringify(spec)} cannot be published`)
      }
    }
  }
  const files = out['files']
  const listed = Array.isArray(files) ? files.filter(f => typeof f === 'string') : []
  for (const need of ['dist', 'bin', 'android', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    if (!listed.includes(need)) errors.push(`packages/plugin/package.json: "files" lacks ${need}`)
  }
  if (errors.length) fail(errors.join('\n'))
  return out
}

interface TarEntry {
  name: string
  data: Buffer
}

/** Minimal reader for the ustar tarballs `pnpm pack` writes. */
function readTgz(file: string): TarEntry[] {
  const tar = zlib.gunzipSync(fs.readFileSync(file))
  const entries: TarEntry[] = []
  const str = (off: number, len: number) => {
    const raw = tar.subarray(off, off + len)
    const end = raw.indexOf(0)
    return raw.subarray(0, end < 0 ? len : end).toString('utf8')
  }
  let off = 0
  while (off + 512 <= tar.length) {
    const name = str(off, 100)
    if (!name) break
    const size = parseInt(str(off + 124, 12).trim() || '0', 8)
    const type = str(off + 156, 1)
    const prefix = str(off + 345, 155)
    const data = tar.subarray(off + 512, off + 512 + size)
    if (type === '' || type === '0') entries.push({ name: prefix ? `${prefix}/${name}` : name, data })
    off += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

function pnpm(args: string[], cwd: string): void {
  console.log(`> pnpm ${args.join(' ')}`)
  // Prefer the pnpm running this script (`pnpm run package`): a JS entry or a standalone executable.
  const execPath = process.env['npm_execpath']
  if (execPath && /pnpm/i.test(path.basename(execPath))) {
    const js = /\.c?js$/.test(execPath)
    execFileSync(js ? process.execPath : execPath, js ? [execPath, ...args] : args, { cwd, stdio: 'inherit' })
  } else {
    execFileSync('pnpm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  }
}

interface BinaryInfo {
  target: string
  exe: string
  raw: Buffer
  br: Buffer
}

function collectBinaries(): BinaryInfo[] {
  const found: BinaryInfo[] = []
  const missing: string[] = []
  for (const t of SERVER_TARGETS) {
    const rawFile = path.join(BIN_DIR, t.target, t.exe)
    const brFile = `${rawFile}.br`
    if (fs.existsSync(rawFile)) {
      const raw = fs.readFileSync(rawFile)
      found.push({ target: t.target, exe: t.exe, raw, br: brotli(raw) })
    } else if (fs.existsSync(brFile)) {
      const br = fs.readFileSync(brFile)
      found.push({ target: t.target, exe: t.exe, raw: zlib.brotliDecompressSync(br), br })
    } else {
      missing.push(`${t.target} (${path.relative(ROOT, rawFile)})`)
    }
  }
  if (missing.length) {
    const message = `missing dsh-env-server binaries: ${missing.join(', ')}`
    if (!values['allow-missing']) fail(`${message}\n(build them with scripts/build-server.ts, or pass --allow-missing)`)
    console.warn(`warning: ${message}; the package will not support those targets`)
  }
  if (!found.length) fail('no dsh-env-server binaries found at all')
  return found
}

async function main(): Promise<void> {
  const source = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8')) as Manifest
  const manifest = publishedManifest(source)
  const name = manifest['name']
  const version = manifest['version']
  if (typeof name !== 'string' || typeof version !== 'string') fail('package.json: name/version must be strings')

  if (!values['no-build']) {
    await buildPlugin({ root: ROOT, release: true })
    await buildClient({ root: ROOT, minify: true })
  }
  const bundle = path.join(PLUGIN_DIR, 'dist', 'index.js')
  const client = path.join(PLUGIN_DIR, 'client.js')
  for (const f of [bundle, client]) {
    if (!fs.existsSync(f)) fail(`${path.relative(ROOT, f)} missing (run pnpm build:plugin / build:client)`)
  }
  if (/from\s*["']@dsh-environments\//.test(fs.readFileSync(bundle, 'utf8'))) {
    fail('dist/index.js imports a workspace package; it must be bundled')
  }
  const binaries = collectBinaries()

  // Stage the package contents.
  // Only remove what this script writes: --out may point at an existing directory.
  fs.mkdirSync(OUT, { recursive: true })
  for (const f of fs.readdirSync(OUT)) {
    if (f === '.stage' || f === 'SHA256SUMS' || /^dsh-env-server-.*\.gz$/.test(f) || /\.tgz$/.test(f)) {
      fs.rmSync(path.join(OUT, f), { recursive: true, force: true })
    }
  }
  fs.mkdirSync(STAGE, { recursive: true })
  fs.cpSync(path.join(PLUGIN_DIR, 'dist'), path.join(STAGE, 'dist'), { recursive: true })
  // The device-side clipboard helper pushed to Android devices, with its source for auditing.
  fs.cpSync(path.join(PLUGIN_DIR, 'android'), path.join(STAGE, 'android'), { recursive: true })
  for (const f of ['client.js', 'cordis.patch.yml', 'README.md']) {
    fs.copyFileSync(path.join(PLUGIN_DIR, f), path.join(STAGE, f))
  }
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(STAGE, 'LICENSE'))
  for (const b of binaries) {
    fs.mkdirSync(path.join(STAGE, 'bin', b.target), { recursive: true })
    fs.writeFileSync(path.join(STAGE, 'bin', b.target, `${b.exe}.br`), b.br)
  }
  fs.writeFileSync(path.join(STAGE, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  // An empty workspace file keeps pnpm from treating the stage as part of the monorepo.
  fs.writeFileSync(path.join(STAGE, 'pnpm-workspace.yaml'), 'packages: []\n')
  pnpm(['pack', '--pack-destination', OUT], STAGE)
  const tgzName = `${name}-${version}.tgz`
  const tgz = path.join(OUT, tgzName)
  if (!fs.existsSync(tgz)) fail(`pnpm pack did not produce ${tgzName}`)

  // Verify what actually ended up in the tarball.
  const entries = new Map(readTgz(tgz).map(e => [e.name, e.data]))
  const expected = [
    'package/package.json',
    'package/dist/index.js',
    'package/client.js',
    'package/cordis.patch.yml',
    'package/README.md',
    'package/LICENSE',
    'package/android/dsh-clipboard.jar',
    'package/android/README.md',
    'package/android/src/dsh/Clipboard.java',
    ...binaries.map(b => `package/bin/${b.target}/${b.exe}.br`),
  ]
  const absent = expected.filter(e => !entries.has(e))
  if (absent.length) fail(`tarball lacks ${absent.join(', ')}`)
  const unexpected = [...entries.keys()].filter(e => !/^package\/(dist|bin)\//.test(e) && !expected.includes(e))
  if (unexpected.length) fail(`tarball has unexpected files: ${unexpected.join(', ')}`)
  const packed = JSON.parse(entries.get('package/package.json')?.toString('utf8') ?? '{}') as Manifest
  if (packed['devDependencies'] || packed['scripts'] || JSON.stringify(packed).includes('workspace:')) {
    fail('packed package.json still has devDependencies / scripts / workspace: specs')
  }
  for (const b of binaries) {
    const data = entries.get(`package/bin/${b.target}/${b.exe}.br`) ?? Buffer.alloc(0)
    if (!zlib.brotliDecompressSync(data).equals(b.raw)) fail(`bin/${b.target}: round trip mismatch`)
  }
  const host = binaries.find(b => b.target === HOST_TARGET)
  if (host) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-env-pkg-'))
    const exe = path.join(tmp, host.exe)
    fs.writeFileSync(
      exe,
      zlib.brotliDecompressSync(entries.get(`package/bin/${host.target}/${host.exe}.br`) ?? Buffer.alloc(0)),
      {
        mode: 0o755,
      },
    )
    const out = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim()
    fs.rmSync(tmp, { recursive: true, force: true })
    console.log(`packaged ${host.target} binary runs: ${out}`)
  }
  fs.rmSync(STAGE, { recursive: true, force: true })

  // Raw per-target binaries for the GitHub release, and the checksums.
  const assets = [tgzName]
  for (const b of binaries) {
    const asset = `dsh-env-server-${version}-${b.target}${b.exe.endsWith('.exe') ? '.exe' : ''}.gz`
    fs.writeFileSync(path.join(OUT, asset), zlib.gzipSync(b.raw, { level: 9 }))
    assets.push(asset)
  }
  const sums = assets.map(a => `${sha256(fs.readFileSync(path.join(OUT, a)))}  ${a}`).join('\n')
  fs.writeFileSync(path.join(OUT, 'SHA256SUMS'), `${sums}\n`)

  console.log('')
  console.log(`target          raw         br`)
  for (const b of binaries) {
    console.log(`${b.target.padEnd(14)} ${kib(b.raw.length).padStart(9)} ${kib(b.br.length).padStart(10)}`)
  }
  console.log('')
  for (const a of [...assets, 'SHA256SUMS']) {
    console.log(
      `${path.relative(ROOT, path.join(OUT, a)).padEnd(52)} ${kib(fs.statSync(path.join(OUT, a)).size).padStart(9)}`,
    )
  }
  const tgzSize = fs.statSync(tgz).size
  const unpacked = [...entries.values()].reduce((n, d) => n + d.length, 0)
  console.log(`\n${tgzName}: ${kib(tgzSize)} (${kib(unpacked)} unpacked, ${entries.size} files)`)
  console.log(`install: dsh plugin add https://github.com/${REPO}/releases/download/v${version}/${tgzName}`)
}

try {
  await main()
} catch (e) {
  if (e instanceof PackageError) {
    console.error(`package: ${e.message}`)
    process.exit(1)
  }
  throw e
}
