// Set or check the release version everywhere it is recorded.
//
//   node scripts/release-version.ts <x.y.z>            write the version
//   node scripts/release-version.ts --check [v]x.y.z   fail unless every location has that version
//   node scripts/release-version.ts --check            fail unless all locations agree
//
// Locations: every workspace package.json, crates/dsh-env-server/Cargo.toml (+ its Cargo.lock
// entry) and CLIENT_ID in packages/protocol/src/types.ts.
import fs from 'node:fs'
import path from 'node:path'
import { CRATE, ROOT } from './server-targets.ts'

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

interface Location {
  file: string
  pattern: RegExp
}

function locations(): Location[] {
  const pkgs = ['package.json', ...fs.readdirSync(path.join(ROOT, 'packages')).map(p => `packages/${p}/package.json`)]
  return [
    ...pkgs
      .filter(p => fs.existsSync(path.join(ROOT, p)))
      .map(file => ({ file, pattern: /^(\s*"version":\s*")([^"]+)(")/m })),
    {
      file: path.relative(ROOT, path.join(CRATE, 'Cargo.toml')),
      pattern: /^(\[package\][^[]*?\nversion = ")([^"]+)(")/m,
    },
    {
      file: path.relative(ROOT, path.join(CRATE, 'Cargo.lock')),
      pattern: /^(name = "dsh-env-server"\nversion = ")([^"]+)(")/m,
    },
    { file: 'packages/protocol/src/types.ts', pattern: /(CLIENT_ID = 'dsh-plugin-environments\/)([^']+)(')/ },
  ].map(l => ({ ...l, file: l.file.replace(/\\/g, '/') }))
}

function read(loc: Location): { text: string; version: string } {
  const text = fs.readFileSync(path.join(ROOT, loc.file), 'utf8').replace(/\r\n/g, '\n')
  const m = loc.pattern.exec(text)
  if (!m?.[2]) throw new Error(`${loc.file}: version not found (${String(loc.pattern)})`)
  return { text, version: m[2] }
}

const args = process.argv.slice(2)
const check = args[0] === '--check'
const wanted = (check ? args[1] : args[0])?.replace(/^v/, '')

if (!check && !wanted) {
  console.error('usage: pnpm release:version <x.y.z> | --check [x.y.z]')
  process.exit(2)
}
if (wanted && !SEMVER.test(wanted)) {
  console.error(`not a semver version: ${wanted}`)
  process.exit(2)
}

const found = locations().map(loc => ({ loc, ...read(loc) }))

if (check) {
  const expected = wanted ?? found.find(f => f.loc.file === 'packages/plugin/package.json')?.version
  const bad = found.filter(f => f.version !== expected)
  for (const f of found) console.log(`${f.version === expected ? 'ok ' : 'BAD'} ${f.loc.file}: ${f.version}`)
  if (bad.length) {
    console.error(`version mismatch: expected ${expected}; run pnpm release:version ${expected ?? '<x.y.z>'}`)
    process.exit(1)
  }
} else if (wanted) {
  for (const f of found) {
    const next = f.text.replace(f.loc.pattern, `$1${wanted}$3`)
    fs.writeFileSync(path.join(ROOT, f.loc.file), next)
    console.log(`${f.loc.file}: ${f.version} -> ${wanted}`)
  }
}
