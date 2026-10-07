// Bundle packages/plugin/src into packages/plugin/dist/index.js (ESM, Node).
// Workspace packages are inlined; ssh2 and the DSH runtime packages stay external.
//
// `watch` keeps esbuild running and rewrites the bundle after every source change. With the
// profile's `hmr` entry watching this directory (see `pnpm dev:hmr`), the running host reloads the
// plugin from the fresh bundle instead of waiting for a restart (see CONTRIBUTING.md).
import { build, context, type Plugin } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'

/**
 * @param release - whitespace/syntax-minified and without a source map (what the published
 *   package ships); development builds keep readable output plus a source map.
 * @param watch - rebuild on every source change instead of returning after one build.
 */
export async function buildPlugin({
  root,
  release = false,
  watch = false,
}: {
  root: string
  release?: boolean
  watch?: boolean
}): Promise<void> {
  const pkgDir = path.join(root, 'packages', 'plugin')
  const outfile = path.join(pkgDir, 'dist', 'index.js')
  const options = {
    entryPoints: [path.join(pkgDir, 'src', 'index.ts')],
    outfile,
    bundle: true,
    format: 'esm' as const,
    platform: 'node' as const,
    target: 'node22',
    packages: 'bundle' as const,
    external: ['ssh2', '@deepseek-ai/*'],
    sourcemap: !release,
    minifySyntax: release,
    minifyWhitespace: release,
    legalComments: 'none' as const,
    logLevel: 'warning' as const,
  }

  if (!watch) {
    fs.rmSync(path.join(pkgDir, 'dist'), { recursive: true, force: true })
    await build(options)
    console.log(`packages/plugin/dist/index.js written${release ? ' (release)' : ''}`)
    return
  }

  // A stale dist/ must not survive a failed first build, but the watcher itself needs the
  // directory to exist only as esbuild's own output target, so leave removal to esbuild.
  const report: Plugin = {
    name: 'dsh-plugin-build-report',
    setup(buildContext) {
      buildContext.onEnd(result => {
        if (result.errors.length > 0) return
        console.log(`packages/plugin/dist/index.js written (${new Date().toLocaleTimeString()})`)
      })
    },
  }

  const buildContext = await context({ ...options, plugins: [report] })
  await buildContext.watch()
  console.log('watching packages/plugin/src (Ctrl-C to stop)')
}
