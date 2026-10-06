// Build everything: the dsh-env-server binaries (host + Linux musl targets via rust-lld), the
// plugin bundle (packages/plugin/dist) and the GUI client (packages/plugin/client.js).
//
//   node scripts/build.ts [--server] [--plugin] [--client] [--dist] [--minify]   (no flag = all)
//
// --dist uses the pinned nightly size-optimised server build (see scripts/build-server.ts for
// target selection and the remaining options).
import { buildClient } from './build-client.ts'
import { buildPlugin } from './build-plugin.ts'
import { buildServer } from './build-server.ts'
import { ROOT } from './server-targets.ts'

const flags = new Set(process.argv.slice(2))
const all = !['--server', '--plugin', '--client'].some(f => flags.has(f))

if (all || flags.has('--server')) buildServer({ dist: flags.has('--dist') })
if (all || flags.has('--plugin')) await buildPlugin({ root: ROOT })
if (all || flags.has('--client')) await buildClient({ root: ROOT, minify: flags.has('--minify') })
