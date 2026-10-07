// Real-session mode: can this machine host a second interactive Windows session, and is the
// installer payload (TermWrap) available next to the plugin?
//
// The probe itself lives in `dsh-env-server session status` 鈥?it is the piece that can read the
// registry, service state, file versions and the session table. TermWrap needs no per-build
// table: it finds the patch offsets in the loaded `termsrv.dll` itself, so a payload either
// works or it does not, and the probe just reports whether a wrapper is installed.
import fs from 'node:fs'
import path from 'node:path'
import { EnvError } from '@dsh-environments/protocol'
import { PACKAGE_ROOT } from '../../paths.ts'
import { runHost } from '../host-process.ts'
import { serverBinary } from '../server/connect.ts'

/** Facts reported by `dsh-env-server session status`. */
export interface SessionProbe {
  ok: boolean
  /** Every prerequisite is met: a session can be started right now. */
  ready: boolean
  /** Machine-readable keys of what is missing (`termwrap-missing`, `rdp-disabled`, ...). */
  missing: string[]
  /** One human-readable sentence per missing key (the server's wording). */
  reasons: string[]
  edition?: string
  termsrv: {
    path: string
    exists: boolean
    /** `10.0.<build>.<revision>` 鈥?the key the RDP Wrapper family matches on. */
    version: string | null
    serviceDll: string | null
    wrapperInstalled: boolean
  }
  rdp: {
    denyConnections: boolean
    service: string
    serviceStart: string
    port: number
    listening: boolean
  }
  system: { rfxvmt: boolean; remoteDesktopUsersGroup: boolean }
  sessions: { id: number; name: string; user: string; state: string }[]
}

/** Where the bundled TermWrap payload lives inside the plugin package. */
export function termwrapDir(): string {
  return path.join(PACKAGE_ROOT, 'vendor', 'termwrap')
}

/** Run the capability probe on this host. */
export async function probeSession(signal?: AbortSignal): Promise<SessionProbe> {
  if (process.platform !== 'win32') {
    throw new EnvError('UNSUPPORTED', 'real sessions are only available on Windows hosts')
  }
  const r = await runHost(serverBinary(), ['session', 'status'], { timeoutMs: 30000, signal })
  const line = r.stdout
    .toString('utf8')
    .split(/\r?\n/)
    .reverse()
    .find(l => l.trim().startsWith('{'))
  if (!line) {
    throw new EnvError('EIO', `session status produced no JSON: ${r.stderr.trim() || r.stdout.toString('utf8').trim()}`)
  }
  const parsed = JSON.parse(line) as SessionProbe
  if (!parsed.ok) throw new EnvError('EIO', 'session status failed')
  return parsed
}

export interface TermwrapPayload {
  dir: string
  /** Version from the payload's own marker file, when present. */
  version: string | null
  license: boolean
  files: { name: string; bytes: number }[]
  /** Whether a payload is present at all (`files.length > 0`). */
  present: boolean
}

/**
 * Describe the TermWrap payload shipped with the release, if any.
 *
 * The payload is plain and MIT-licensed (`scripts/stage-termwrap.ts` stages it); it travels inside
 * our own release package, so it needs no separate integrity file. Nothing here patches the
 * machine: a payload that is not present simply makes the install action unavailable.
 */
export function termwrapPayload(dir = termwrapDir()): TermwrapPayload {
  const files: TermwrapPayload['files'] = []
  let version: string | null = null
  let license = false
  try {
    const marker = path.join(dir, 'VERSION')
    if (fs.existsSync(marker)) version = fs.readFileSync(marker, 'utf8').trim() || null
    license = fs.existsSync(path.join(dir, 'LICENSE'))
    for (const name of fs.readdirSync(dir)) {
      if (name === 'VERSION' || name === 'LICENSE' || name === 'README.md') continue
      const file = path.join(dir, name)
      const stat = fs.statSync(file)
      if (!stat.isFile()) continue
      files.push({ name, bytes: stat.size })
    }
  } catch {
    // A missing directory is the normal case for a build without the payload.
  }
  return { dir, version, license, files, present: files.length > 0 }
}
