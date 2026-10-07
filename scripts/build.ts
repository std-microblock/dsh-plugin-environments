// Build everything: the dsh-env-server binaries (host + Linux musl targets via rust-lld), the
// plugin bundle (packages/plugin/dist) and the GUI client (packages/plugin/client.js).
//
//   node scripts/build.ts [--server] [--plugin] [--client] [--dist] [--minify] [--watch]
//   (no target flag = all three)
//
// --dist uses the pinned nightly size-optimised server build (see scripts/build-server.ts for
// target selection and the remaining options).
//
// --watch rebuilds the plugin bundle and the GUI client on every source change and keeps running;
// DSH then reloads both halves in place (see CONTRIBUTING.md). The Rust server is not watched: it
// is built once, and only when --server is passed explicitly.
import { buildClient } from './build-client.ts'
import { buildPlugin } from './build-plugin.ts'
import { buildServer } from './build-server.ts'
import { hmrHint } from './dev-hmr.ts'
import { ROOT } from './server-targets.ts'

const flags = new Set(process.argv.slice(2))
const watch = flags.has('--watch')
const all = !['--server', '--plugin', '--client'].some(f => flags.has(f))

if ((all && !watch) || flags.has('--server')) {
  if (watch) console.log('build.ts: --watch does not apply to the Rust server; building it once')
  buildServer({ dist: flags.has('--dist') })
}
if (all || flags.has('--plugin')) await buildPlugin({ root: ROOT, watch })
if (all || flags.has('--client')) await buildClient({ root: ROOT, minify: flags.has('--minify'), watch })

if (watch) console.log(hmrHint(process.env['DSH_PROFILE'] || 'desktop'))
