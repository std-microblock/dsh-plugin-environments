#!/usr/bin/env node
// Stage the TermWrap payload the release bundles (`packages/plugin/vendor/termwrap`).
//
// TermWrap (MIT, © 2022 llccd) is a third-party patch: it takes over the Terminal Services
// service DLL and patches the loaded image in memory so a client SKU can host several sessions,
// and it finds its own patch offsets at run time (no per-build tables).
//
// Usage:
//   node scripts/fetch-termwrap.ts --from <zip|dir> --version <upstream-version>
//   node scripts/fetch-termwrap.ts                 # list what is staged
//
// The script never downloads anything: fetch the release you intend to ship, review it, then
// stage it from the local file. The payload then travels inside our release package, so it needs
// no separate integrity file.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = path.join(ROOT, 'packages', 'plugin', 'vendor', 'termwrap')
const LICENSE_SOURCE = 'https://github.com/llccd/TermWrap'
/** The release archive carries no licence file, so the MIT text is embedded here. */
const MIT = `MIT License

Copyright (c) 2022 llccd and the other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
/** Files that describe the payload rather than belong to it. */
const META = new Set(['VERSION', 'LICENSE', 'README.md'])

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** Extract a release archive with tar.exe (it reads zip on Windows 10+). */
function unpack(from: string): string {
  if (fs.statSync(from).isDirectory()) return from
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-termwrap-'))
  execFileSync('tar', ['-xf', from, '-C', dir], { stdio: 'inherit' })
  return dir
}

/**
 * Find the files we ship, wherever the archive nested them.
 *
 * The release carries both architectures; the service host on 64-bit Windows is x64, so only
 * `x64/` is staged. `Zydis.dll` is required — it is the disassembler TermWrap uses to search for
 * its patch offsets. `EndpWrap.dll` (audio recording redirection) is deliberately left out: it
 * loads into every application that plays remote audio and upstream warns it can hang some of
 * them, and it needs files in `System32`.
 */
function collect(dir: string): Map<string, string> {
  const found = new Map<string, string>()
  const wanted = /^(TermWrap|UmWrap|Zydis)\.dll$/i
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === 'x86') continue
        walk(full)
      } else if (wanted.test(entry.name) || /\.reg$/i.test(entry.name)) {
        found.set(entry.name, full)
      }
    }
  }
  walk(dir)
  return found
}

function stage(from: string): void {
  const files = collect(unpack(from))
  if (![...files.keys()].some(n => /^TermWrap\.dll$/i.test(n))) {
    console.error('the source has no TermWrap.dll — is this really a TermWrap release?')
    process.exit(1)
  }
  fs.mkdirSync(VENDOR, { recursive: true })
  // Replace a previously staged payload, but keep the hand-written README next to it.
  for (const name of fs.readdirSync(VENDOR)) {
    if (name === 'README.md') continue
    fs.rmSync(path.join(VENDOR, name), { force: true, recursive: true })
  }
  for (const [name, src] of [...files].sort()) fs.copyFileSync(src, path.join(VENDOR, name))
  fs.writeFileSync(path.join(VENDOR, 'VERSION'), `${arg('--version') ?? new Date().toISOString().slice(0, 10)}\n`)
  // The archive ships no licence file; keep the upstream MIT text with the payload.
  fs.writeFileSync(path.join(VENDOR, 'LICENSE'), MIT)
  console.log(`staged ${files.size} file(s) into ${path.relative(ROOT, VENDOR)} (LICENSE from ${LICENSE_SOURCE}):`)
  console.log([...files.keys()].sort().join('\n'))
}

/** Report what is staged, so a release build can see whether the payload made it in. */
function list(): void {
  const staged = fs.existsSync(VENDOR) ? fs.readdirSync(VENDOR).filter(f => !META.has(f) && f !== 'README.md') : []
  if (!staged.length) {
    console.log('no payload staged (the release simply omits the TermWrap installer)')
    return
  }
  const version = fs.readFileSync(path.join(VENDOR, 'VERSION'), 'utf8').trim()
  console.log(`TermWrap ${version}: ${staged.sort().join(', ')}`)
}

const from = arg('--from')
if (from) stage(from)
else list()
