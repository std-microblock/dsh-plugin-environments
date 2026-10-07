// Pure interpretation of `session.status`: which single step the user has to take next, and the
// prerequisite checklist shown behind "Details". Kept free of React so it can be unit-tested.

export interface SessionStatusView {
  ok: boolean
  ready: boolean
  missing: string[]
  reasons: string[]
  edition?: string
  /** `home` | `client` | `server` */
  editionKind?: 'home' | 'client' | 'server'
  /** Whether this machine needs the TermWrap patch at all (false on a Server SKU). */
  needsTermWrap?: boolean
  termsrv?: { version: string | null; wrapperInstalled: boolean }
  rdp?: { listening: boolean; service: string }
  termwrap: {
    present: boolean
    version: string | null
    license: string | null
    files: string[]
  }
}

/**
 * The one thing to do next:
 * - `ready`       nothing, the mode works;
 * - `install`     install the bundled TermWrap (client SKUs);
 * - `manual`      TermWrap is needed but this build does not bundle it;
 * - `reboot`      TermWrap is in place, Windows only loads it at start-up;
 * - `enable`      a Server SKU only needs its Remote Desktop host switched on;
 * - `unsupported` not a Windows host.
 */
export type SessionPhase = 'ready' | 'install' | 'manual' | 'reboot' | 'enable' | 'unsupported'

export type SessionCheckId = 'termwrap' | 'rdp' | 'rfxvmt' | 'group' | 'service' | 'listener'

export interface SessionCheck {
  id: SessionCheckId
  ok: boolean
  /** The server's sentence for a failed check (tooltip). */
  reason?: string | undefined
}

const CHECK_KEYS: [SessionCheckId, string][] = [
  ['termwrap', 'termwrap-missing'],
  ['rdp', 'rdp-disabled'],
  ['rfxvmt', 'rfxvmt-missing'],
  ['group', 'rd-users-group-missing'],
  ['service', 'term-service-stopped'],
  ['listener', 'listener-down'],
]

export function needsTermWrap(status: SessionStatusView): boolean {
  return status.needsTermWrap ?? status.editionKind !== 'server'
}

export function sessionPhase(status: SessionStatusView, installedThisRun = false): SessionPhase {
  if (status.ready) return 'ready'
  if (status.missing.includes('not-windows')) return 'unsupported'
  if (!needsTermWrap(status)) return 'enable'
  // The wrapper is registered as the service DLL, but Terminal Services only loads it at boot.
  if (installedThisRun || status.termsrv?.wrapperInstalled || !status.missing.includes('termwrap-missing'))
    return 'reboot'
  return status.termwrap.present ? 'install' : 'manual'
}

/** Every prerequisite, in a stable order, with whether it is met. */
export function sessionChecks(status: SessionStatusView): SessionCheck[] {
  const termwrap = needsTermWrap(status)
  return CHECK_KEYS.filter(([id]) => termwrap || id !== 'termwrap').map(([id, key]) => {
    const i = status.missing.indexOf(key)
    return { id, ok: i < 0, reason: i < 0 ? undefined : status.reasons[i] }
  })
}
