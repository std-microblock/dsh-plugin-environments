// Locations of files shipped with (or built next to) the plugin package.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-plugin-environments'

/**
 * Root directory of the plugin package (the one holding `bin/`). Works both from the bundled
 * `dist/index.js` and from the TypeScript sources used by tests.
 */
function findPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const manifest = path.join(dir, 'package.json')
    try {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: unknown }
      if (pkg.name === PACKAGE_NAME) return dir
    } catch {
      // no manifest here
    }
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    dir = parent
  }
}

export const PACKAGE_ROOT = findPackageRoot()

/** Directory of the prebuilt `dsh-env-server` binaries: `bin/<platform>-<arch>/`. */
export function binDir(target = `${process.platform}-${process.arch}`): string {
  return path.join(PACKAGE_ROOT, 'bin', target)
}

/** Cargo target directory of the server crate when running from a source checkout. */
export const CRATE_TARGET_DIR = path.join(PACKAGE_ROOT, '..', '..', 'crates', 'dsh-env-server', 'target')
