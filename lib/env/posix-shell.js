// Helpers for environments that are driven through a POSIX shell (adb, plain ssh).

/** Single-quote a string for sh. */
export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** Convert a glob (`**`, `*`, `?`, `{a,b}`, `[...]`) to a RegExp over '/'-separated relative paths. */
export function globToRegExp(pattern) {
  let p = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!p.includes('/')) p = `**/${p}`
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
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
      if (end < 0) { re += '\\{'; continue }
      re += `(?:${p.slice(i + 1, end).split(',').map(escapeRe).join('|')})`
      i = end
    } else if (c === '[') {
      const end = p.indexOf(']', i)
      if (end < 0) { re += '\\['; continue }
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

function escapeRe(s) {
  return s.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')
}

/** Map `stat -c %F` output to protocol types. */
export function statType(f) {
  if (f.includes('directory')) return 'dir'
  if (f.includes('symbolic')) return 'symlink'
  if (f.includes('regular')) return 'file'
  return 'other'
}

/** Script: print `TYPE|SIZE|MTIME|MODE` for a path, or `MISSING`. */
export function statScript(path, follow = true) {
  return `if [ -e ${shq(path)} ] || [ -L ${shq(path)} ]; then stat ${follow ? '-L ' : ''}-c '%F|%s|%Y|%a' ${shq(path)}; else echo MISSING; fi`
}

export function parseStat(out) {
  const line = out.trim().split('\n').pop() ?? ''
  if (line === 'MISSING' || line === '') return null
  const [f, size, mtime, mode] = line.split('|')
  return { type: statType(f), size: Number(size) || 0, mtimeMs: (Number(mtime) || 0) * 1000, mode: parseInt(mode, 8) || 0 }
}

/** Script listing a directory as `NAME|TYPE|SIZE|MTIME` lines. */
export function readdirScript(path) {
  return `cd ${shq(path)} || exit 3; ls -A1 | while IFS= read -r f; do stat -L -c '%n|%F|%s|%Y' -- "$f" 2>/dev/null || echo "$f|symbolic link|0|0"; done`
}

export function parseReaddir(out) {
  const entries = []
  for (const line of out.split('\n')) {
    if (!line.includes('|')) continue
    const parts = line.split('|')
    const mtime = parts.pop()
    const size = parts.pop()
    const f = parts.pop()
    const name = parts.join('|')
    if (name === '*' || name === '.*' || name === '.' || name === '..') continue
    entries.push({ name, type: statType(f), size: Number(size) || 0, mtimeMs: (Number(mtime) || 0) * 1000 })
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return entries
}

/** Script listing files under cwd as `MTIME|relative/path` (excluding hidden dirs unless hidden). */
export function findScript(cwd, { hidden = false, maxDepth } = {}) {
  const prune = hidden ? '' : `\\( -name '.*' -a ! -name . \\) -prune -o `
  const depth = maxDepth ? `-maxdepth ${maxDepth} ` : ''
  return `cd ${shq(cwd)} || exit 3; find . ${depth}${prune}\\( -type f -o -type d \\) -print 2>/dev/null | head -n 200000`
}

/** Filter find output with a glob; returns relative paths. */
export function filterGlob(out, pattern, limit = 1000) {
  const re = globToRegExp(pattern)
  const paths = []
  let truncated = false
  for (let line of out.split('\n')) {
    line = line.trim()
    if (!line || line === '.') continue
    const rel = line.replace(/^\.\//, '')
    if (re.test(rel)) {
      if (paths.length >= limit) { truncated = true; break }
      paths.push(rel)
    }
  }
  return { paths, truncated }
}

/** grep invocation printing `path:line:text`. */
export function grepScript(cwd, pattern, { path, literal, ignoreCase, filesOnly, glob } = {}) {
  const flags = ['-r', '-n', '-I', '-s']
  if (literal) flags.push('-F')
  else flags.push('-E')
  if (ignoreCase) flags.push('-i')
  if (filesOnly) flags.push('-l')
  if (glob && !glob.includes('/')) flags.push(`--include=${shq(glob)}`)
  const target = path ? shq(path) : '.'
  return `cd ${shq(cwd)} || exit 3; grep ${flags.join(' ')} -e ${shq(pattern)} ${target} 2>/dev/null | head -n 20000`
}

export function parseGrep(out, { filesOnly, limit = 500, glob } = {}) {
  const re = glob && glob.includes('/') ? globToRegExp(glob) : undefined
  const matches = []
  const files = new Set()
  let truncated = false
  for (const raw of out.split('\n')) {
    if (!raw) continue
    if (filesOnly) {
      const rel = raw.replace(/^\.\//, '')
      if (re && !re.test(rel)) continue
      if (files.size >= limit) { truncated = true; break }
      files.add(rel)
      continue
    }
    const m = /^(.*?):(\d+):(.*)$/.exec(raw)
    if (!m) continue
    const rel = m[1].replace(/^\.\//, '')
    if (re && !re.test(rel)) continue
    if (matches.length >= limit) { truncated = true; break }
    files.add(rel)
    matches.push({ path: rel, line: Number(m[2]), text: m[3].length > 500 ? `${m[3].slice(0, 500)}…` : m[3] })
  }
  return { matches, files: [...files], truncated }
}
