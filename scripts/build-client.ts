// Bundle packages/client into packages/plugin/client.js in the DSH client-module lazy-CJS factory format.
import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function buildClient({ root, minify = false }: { root: string; minify?: boolean }): Promise<void> {
  const pluginDir = path.join(root, 'packages', 'plugin')
  const pkg = JSON.parse(await readFile(path.join(pluginDir, 'package.json'), 'utf8')) as { name: string }

  const result = await build({
    entryPoints: [path.join(root, 'packages', 'client', 'src', 'index.tsx')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    external: ['react', 'react-dom', '@deepseek-ai/*'],
    loader: { '.css': 'text' },
    legalComments: 'none',
    minify,
    logLevel: 'warning',
  })

  const code = result.outputFiles[0]?.text ?? ''
  const output = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory(require) {
\t\tconst module = { exports: {} };
\t\t(function (module, exports, require) {
${code}
\t\t})(module, module.exports, require);
\t\tconst entry = module.exports;
\t\treturn { inject: entry.inject, apply: entry.apply };
\t},
});
`
  await writeFile(path.join(pluginDir, 'client.js'), output, 'utf8')
  console.log(`packages/plugin/client.js: ${output.length} bytes`)
}
