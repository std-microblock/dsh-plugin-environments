// Helpers for environments that are driven through a POSIX shell (adb, plain ssh).
import type { DirEntry, FileType, GlobResult, GrepMatch, GrepResult, Stat } from '@dsh-environments/protocol'

/** Single-quote a string for sh. */
export function shq(s: unknown): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** Convert a glob (`**`, `*`, `?`, `{a,b}`, `[...]`) to a RegExp over '/'-separated relative paths. */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!p.includes('/')) p = `**/${p}`
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p.charAt(i)
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++
        if (p[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '{') {
      const end = p.indexOf('}', i)
      if (end < 0) {
        re += '\\{'
        continue
      }
      re += `(?:${p
        .slice(i + 1, end)
        .split(',')
        .map(escapeRe)
        .join('|')})`
      i = end
    } else if (c === '[') {
      const end = p.indexOf(']', i)
      if (end < 0) {
        re += '\\['
        continue
      }
      let cls = p.slice(i + 1, end)
      if (cls.startsWith('!')) cls = `^${cls.slice(1)}`
      re += `[${cls}]`
      i = end
    } else {
      re += escapeRe(c)
    }
  }
  return new RegExp(`^${re}$`)
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')
}

/** Map `stat -c %F` output to protocol types. */
export function statType(f: string): FileType {
  if (f.includes('directory')) return 'dir'
  if (f.includes('symbolic')) return 'symlink'
  if (f.includes('regular')) return 'file'
  return 'other'
}

/** Script: print `TYPE|SIZE|MTIME|MODE` for a path, or `MISSING`. */
export function statScript(path: string, follow = true): string {
  return `if [ -e ${shq(path)} ] || [ -L ${shq(path)} ]; then stat ${follow ? '-L ' : ''}-c '%F|%s|%Y|%a' ${shq(path)}; else echo MISSING; fi`
}

export function parseStat(out: string): Stat | null {
  const line = out.trim().split(/\r?\n/).pop() ?? ''
  if (line === 'MISSING' || line === '') return null
  const [f = '', size, mtime, mode = ''] = line.split('|')
  return {
    type: statType(f),
    size: Number(size) || 0,
    mtimeMs: (Number(mtime) || 0) * 1000,
    mode: parseInt(mode, 8) || 0,
  }
}

/** Script listing a directory as `NAME|TYPE|SIZE|MTIME` lines. */
export function readdirScript(path: string): string {
  return `cd ${shq(path)} || exit 3; ls -A1 | while IFS= read -r f; do stat -L -c '%n|%F|%s|%Y' -- "$f" 2>/dev/null || echo "$f|symbolic link|0|0"; done`
}

export function parseReaddir(out: string): DirEntry[] {
  const entries: DirEntry[] = []
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes('|')) continue
    const parts = line.split('|')
    const mtime = parts.pop()
    const size = parts.pop()
    const f = parts.pop() ?? ''
    const name = parts.join('|')
    if (name === '*' || name === '.*' || name === '.' || name === '..') continue
    entries.push({ name, type: statType(f), size: Number(size) || 0, mtimeMs: (Number(mtime) || 0) * 1000 })
  }
  entries.sort(byName)
  return entries
}

/** Stable sort by name (code-unit order). */
export function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** Script listing files under cwd as relative paths (excluding hidden dirs unless hidden). */
export function findScript(
  cwd: string,
  { hidden = false, maxDepth }: { hidden?: boolean | undefined; maxDepth?: number } = {},
): string {
  const prune = hidden ? '' : `\\( -name '.*' -a ! -name . \\) -prune -o `
  const depth = maxDepth ? `-maxdepth ${maxDepth} ` : ''
  return `cd ${shq(cwd)} || exit 3; find . ${depth}${prune}\\( -type f -o -type d \\) -print 2>/dev/null | head -n 200000`
}

/** Filter find output with a glob; returns relative paths. */
export function filterGlob(out: string, pattern: string, limit = 1000): GlobResult {
  const re = globToRegExp(pattern)
  const paths: string[] = []
  let truncated = false
  for (let line of out.split(/\r?\n/)) {
    line = line.trim()
    if (!line || line === '.') continue
    const rel = line.replace(/^\.\//, '')
    if (re.test(rel)) {
      if (paths.length >= limit) {
        truncated = true
        break
      }
      paths.push(rel)
    }
  }
  return { paths, truncated }
}

export interface GrepScriptOptions {
  path?: string | undefined
  literal?: boolean | undefined
  ignoreCase?: boolean | undefined
  filesOnly?: boolean | undefined
  glob?: string | undefined
}

/** grep invocation printing `path:line:text`. */
export function grepScript(
  cwd: string,
  pattern: string,
  { path, literal, ignoreCase, filesOnly, glob }: GrepScriptOptions = {},
): string {
  const flags = ['-r', '-n', '-I', '-s']
  if (literal) flags.push('-F')
  else flags.push('-E')
  if (ignoreCase) flags.push('-i')
  if (filesOnly) flags.push('-l')
  if (glob && !glob.includes('/')) flags.push(`--include=${shq(glob)}`)
  const target = path ? shq(path) : '.'
  return `cd ${shq(cwd)} || exit 3; grep ${flags.join(' ')} -e ${shq(pattern)} ${target} 2>/dev/null | head -n 20000`
}

export function parseGrep(
  out: string,
  { filesOnly, limit = 500, glob }: { filesOnly?: boolean | undefined; limit?: number; glob?: string | undefined } = {},
): GrepResult {
  const re = glob && glob.includes('/') ? globToRegExp(glob) : undefined
  const matches: GrepMatch[] = []
  const files = new Set<string>()
  let truncated = false
  for (const raw of out.split(/\r?\n/)) {
    if (!raw) continue
    if (filesOnly) {
      const rel = raw.replace(/^\.\//, '')
      if (re && !re.test(rel)) continue
      if (files.size >= limit) {
        truncated = true
        break
      }
      files.add(rel)
      continue
    }
    const m = /^(.*?):(\d+):(.*)$/.exec(raw)
    if (!m) continue
    const [, file = '', line, text = ''] = m
    const rel = file.replace(/^\.\//, '')
    if (re && !re.test(rel)) continue
    if (matches.length >= limit) {
      truncated = true
      break
    }
    files.add(rel)
    matches.push({ path: rel, line: Number(line), text: text.length > 500 ? `${text.slice(0, 500)}…` : text })
  }
  return { matches, files: [...files], truncated }
}
