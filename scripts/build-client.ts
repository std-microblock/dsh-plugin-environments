// Bundle packages/client into packages/plugin/client.js in the DSH client-module lazy-CJS factory format.
//
// `watch` keeps esbuild running and rewrites the bundle after every source change. DSH's client-hmr
// transport stat-polls that artifact and hot-replaces the plugin in the open page, so `pnpm dev`
// plus a `link:` install gives the GUI a rebuild-and-reload loop with no page refresh (see
// CONTRIBUTING.md).
import { build, context, type BuildOptions, type BuildResult, type Plugin } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Wrap bundled code in the DSH client-module factory the page evaluates on load and on reload. */
function wrapModule(name: string, code: string): string {
  return `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(name)},
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
}

export async function buildClient({
  root,
  minify = false,
  watch = false,
}: {
  root: string
  minify?: boolean
  watch?: boolean
}): Promise<void> {
  const pluginDir = path.join(root, 'packages', 'plugin')
  const pkg = JSON.parse(await readFile(path.join(pluginDir, 'package.json'), 'utf8')) as { name: string }
  const outfile = path.join(pluginDir, 'client.js')

  // write: false keeps the bundle in memory so the wrapper can be added around it; the wrapper is
  // the only thing written to disk, on both the one-shot and the watch path.
  const options: BuildOptions = {
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
  }

  const emit = async (result: BuildResult): Promise<void> => {
    const output = wrapModule(pkg.name, result.outputFiles?.[0]?.text ?? '')
    await writeFile(outfile, output, 'utf8')
    console.log(
      `packages/plugin/client.js: ${output.length} bytes${watch ? ` (${new Date().toLocaleTimeString()})` : ''}`,
    )
  }

  if (!watch) {
    await emit(await build(options))
    return
  }

  const emitOnRebuild: Plugin = {
    name: 'dsh-client-module-wrapper',
    setup(buildContext) {
      buildContext.onEnd(async result => {
        if (result.errors.length > 0) return
        await emit(result)
      })
    },
  }

  const buildContext = await context({ ...options, plugins: [emitOnRebuild] })
  await buildContext.watch()
  console.log('watching packages/client (Ctrl-C to stop)')
}
