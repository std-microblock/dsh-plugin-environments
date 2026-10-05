// Bundle src/client into client.js in the DSH client-module lazy-CJS factory format.
import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))

const result = await build({
  entryPoints: [join(ROOT, 'src', 'client', 'index.jsx')],
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
  minify: process.argv.includes('--minify'),
  logLevel: 'warning',
})

const code = result.outputFiles[0].text
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
await writeFile(join(ROOT, 'client.js'), output, 'utf8')
console.log(`client.js: ${output.length} bytes`)
