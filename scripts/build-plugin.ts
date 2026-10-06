// Bundle packages/plugin/src into packages/plugin/dist/index.js (ESM, Node).
// Workspace packages are inlined; ssh2 and the DSH runtime packages stay external.
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'

/**
 * @param release - whitespace/syntax-minified and without a source map (what the published
 *   package ships); development builds keep readable output plus a source map.
 */
export async function buildPlugin({ root, release = false }: { root: string; release?: boolean }): Promise<void> {
  const pkgDir = path.join(root, 'packages', 'plugin')
  const outfile = path.join(pkgDir, 'dist', 'index.js')
  fs.rmSync(path.join(pkgDir, 'dist'), { recursive: true, force: true })
  await build({
    entryPoints: [path.join(pkgDir, 'src', 'index.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'bundle',
    external: ['ssh2', '@deepseek-ai/*'],
    sourcemap: !release,
    minifySyntax: release,
    minifyWhitespace: release,
    legalComments: 'none',
    logLevel: 'warning',
  })
  console.log(`packages/plugin/dist/index.js written${release ? ' (release)' : ''}`)
}
