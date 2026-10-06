// Bundle packages/plugin/src into packages/plugin/dist/index.js (ESM, Node).
// Workspace packages are inlined; ssh2 and the DSH runtime packages stay external.
import { build } from 'esbuild'
import path from 'node:path'

export async function buildPlugin({ root }: { root: string }): Promise<void> {
  const pkgDir = path.join(root, 'packages', 'plugin')
  const outfile = path.join(pkgDir, 'dist', 'index.js')
  await build({
    entryPoints: [path.join(pkgDir, 'src', 'index.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'bundle',
    external: ['ssh2', '@deepseek-ai/*'],
    sourcemap: true,
    legalComments: 'none',
    logLevel: 'warning',
  })
  console.log(`packages/plugin/dist/index.js written`)
}
