// Enable the host-side half of the development hot-reload loop.
//
// DSH reloads plugin code while the host runs (packages/boot/hmr in the DSH checkout). The base
// bundle already enables the `hmr` entry for profile hosts, but its module watch roots are opt-in
// (`root: []`), so a rebuilt plugin bundle is only picked up after a restart. This script gives
// that entry a watch root covering this checkout's built plugin, so `pnpm dev` rebuilding
// packages/plugin/dist/index.js reloads the plugin in the running host.
//
//   node scripts/dev-hmr.ts [--profile <name>]      add/refresh the block
//   node scripts/dev-hmr.ts --check                 report whether it is in place (exit 1 otherwise)
//   node scripts/dev-hmr.ts --remove                take the block back out
//
// The profile patch is watched, so a running host applies the change without a restart; a host
// started later reads it at boot. The client half needs no profile change: DSH's client-hmr
// stat-polls packages/plugin/client.js on its own.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_DIR } from './server-targets.ts'

const BEGIN = '# --- dsh-plugin-environments dev HMR (managed by `pnpm dev:hmr`) ---'
const END = '# --- end dev HMR ---'

/** Default profile: the one CONTRIBUTING.md installs the plugin into. */
const DEFAULT_PROFILE = 'desktop'

/** How a profile patch stands relative to the dev HMR block. */
export type HmrPatchState =
  | { kind: 'configured'; patch: string }
  | { kind: 'stale'; patch: string }
  | { kind: 'not-configured'; patch: string }
  | { kind: 'no-patch'; patch: string }
  | { kind: 'no-profile'; dir: string }

/** Profile directory under the DSH home, honouring `DSH_HOME`. */
function profileDir(profile: string): string {
  const home = process.env['DSH_HOME'] || path.join(os.homedir(), '.dsh')
  return path.join(home, 'profiles', profile)
}

function patchFile(profile: string): string {
  return path.join(profileDir(profile), 'cordis.patch.yml')
}

/** Watch root as it is written into the patch: forward slashes survive YAML and chokidar alike. */
function watchRoot(): string {
  return PLUGIN_DIR.replaceAll('\\', '/')
}

/** The patch entry that makes the profile's `hmr` entry watch this checkout's built plugin. */
function hmrBlock(): string {
  return [
    BEGIN,
    '- id: hmr',
    "  name: '@deepseek-ai/dsh-hmr'",
    '  disabled: false',
    '  config:',
    '    root:',
    `      - '${watchRoot()}'`,
    END,
  ].join('\n')
}

function readPatch(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Locate the managed block in a patch file. */
function blockRange(text: string): { start: number; end: number } | undefined {
  const start = text.indexOf(BEGIN)
  if (start < 0) return undefined
  const marker = text.indexOf(END, start)
  if (marker < 0) throw new Error(`unterminated dev HMR block (missing "end dev HMR" marker)`)
  return { start, end: marker + END.length }
}

/** Replace the managed block, or append it after the file's existing entries. */
function applyBlock(text: string, block: string): { text: string; action: 'updated' | 'added' } {
  const range = blockRange(text)
  if (range) return { text: `${text.slice(0, range.start)}${block}${text.slice(range.end)}`, action: 'updated' }
  const body = text.replace(/\s*$/, '')
  return { text: `${body}${body ? '\n\n' : ''}${block}\n`, action: 'added' }
}

/** Remove the managed block and the blank line it introduced. */
function removeBlock(text: string): string {
  const range = blockRange(text)
  if (!range) return text
  const before = text.slice(0, range.start).replace(/\n+$/, '')
  const after = text.slice(range.end).replace(/^\n+/, '')
  if (!before) return after
  return after ? `${before}\n\n${after}` : `${before}\n`
}

/** Current state of the dev HMR block for one profile. */
export function hmrPatchState(profile: string): HmrPatchState {
  const dir = profileDir(profile)
  if (!fs.existsSync(dir)) return { kind: 'no-profile', dir }
  const patch = patchFile(profile)
  const text = readPatch(patch)
  if (text === undefined) return { kind: 'no-patch', patch }
  const range = blockRange(text)
  if (range === undefined) return { kind: 'not-configured', patch }
  // The host rewrites the patch file on reload (it normalizes blank lines), so compare the block's
  // content rather than the exact text that was written.
  const block = text.slice(range.start, range.end)
  const roots = [watchRoot(), PLUGIN_DIR]
  return roots.some(root => block.includes(root)) ? { kind: 'configured', patch } : { kind: 'stale', patch }
}

/** One-line hint for `pnpm dev` about the host half of the reload loop. */
export function hmrHint(profile: string): string {
  const state = hmrPatchState(profile)
  switch (state.kind) {
    case 'configured':
      return `host HMR: profile "${profile}" watches ${PLUGIN_DIR}`
    case 'stale':
      return `host HMR: re-run \`pnpm dev:hmr\` — the block in ${state.patch} points elsewhere`
    case 'not-configured':
      return `host HMR: run \`pnpm dev:hmr\` once to add the watch root to ${state.patch}`
    case 'no-patch':
      return `host HMR: run \`pnpm dev:hmr\` once to create ${state.patch}`
    case 'no-profile':
      return `host HMR: no profile "${profile}" at ${state.dir}`
  }
}

function fail(message: string): never {
  console.error(`dev-hmr: ${message}`)
  process.exit(2)
}

/** Command-line interface; skipped when another script imports the helpers above. */
function main(): void {
  const args = process.argv.slice(2)
  const profileAt = args.indexOf('--profile')
  const profile = profileAt >= 0 ? args[profileAt + 1] : process.env['DSH_PROFILE'] || DEFAULT_PROFILE
  if (profile === undefined) fail('--profile needs a name')

  if (args.includes('--check')) {
    const state = hmrPatchState(profile)
    switch (state.kind) {
      case 'configured':
        console.log(`dev-hmr: configured — ${state.patch}`)
        break
      case 'stale':
        console.log(`dev-hmr: stale — ${state.patch} (re-run without --check to refresh)`)
        process.exitCode = 1
        break
      case 'not-configured':
        console.log(`dev-hmr: not configured — ${state.patch}`)
        process.exitCode = 1
        break
      case 'no-patch':
        console.log(`dev-hmr: no patch file — ${state.patch}`)
        process.exitCode = 1
        break
      case 'no-profile':
        console.log(`dev-hmr: no profile "${profile}" at ${state.dir}`)
        process.exitCode = 1
        break
    }
    return
  }

  const patch = patchFile(profile)
  const dir = profileDir(profile)
  if (!fs.existsSync(dir)) {
    fail(
      `no profile "${profile}" at ${dir}\n` +
        `  install the plugin into it first: dsh plugin --profile ${profile} add link:${PLUGIN_DIR}`,
    )
  }
  const existing = readPatch(patch) ?? ''
  if (args.includes('--remove')) {
    const text = removeBlock(existing)
    if (text === existing) {
      console.log(`dev-hmr: nothing to remove in ${patch}`)
    } else {
      fs.writeFileSync(patch, text, 'utf8')
      console.log(`dev-hmr: removed the dev HMR block from ${patch}`)
    }
    return
  }
  const { text, action } = applyBlock(existing, hmrBlock())
  fs.writeFileSync(patch, text, 'utf8')
  console.log(`dev-hmr: ${action} the dev HMR block in ${patch}`)
  console.log(`  root: ${PLUGIN_DIR}`)
  console.log('  a running host picks it up on its own; otherwise it applies at the next start')
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
