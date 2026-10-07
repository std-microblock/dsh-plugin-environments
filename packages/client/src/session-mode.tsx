// Separate-session mode: one real Windows session per isolated account (own pointer, real input).
//
// A client SKU allows only one session at a time — and Home does not host Remote Desktop at all —
// so TermWrap (MIT, bundled in the clear) has to be installed and the machine rebooted; a Server
// SKU only needs its Remote Desktop host switched on. The status is probed once per page and
// shared between the Environments page panel and the account dialog, and the UI always offers
// exactly one next step, with the full prerequisite checklist behind "Details".
import * as React from 'react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { call, messageOf } from './api.ts'
import type { Translate } from './host-api.ts'
import { IconCheck, IconChevron, IconDesktopSession, IconRefresh, IconSpinner } from './icons.tsx'
import { sessionChecks, sessionPhase, type SessionPhase, type SessionStatusView } from './session-logic.ts'

export type { SessionStatusView } from './session-logic.ts'

interface Snapshot {
  status: SessionStatusView | undefined
  error: string | undefined
  loading: boolean
  /** Set after a successful install in this page: a reboot is pending whatever the probe says. */
  installed: boolean
}

let snapshot: Snapshot = { status: undefined, error: undefined, loading: false, installed: false }
const listeners = new Set<() => void>()
const set = (patch: Partial<Snapshot>) => {
  snapshot = { ...snapshot, ...patch }
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

async function probe(): Promise<void> {
  if (snapshot.loading) return
  set({ loading: true, error: undefined })
  try {
    set({ status: await call<SessionStatusView>('session.status'), loading: false })
  } catch (e) {
    set({ error: messageOf(e), loading: false })
  }
}

export interface SessionState extends Snapshot {
  phase: SessionPhase | undefined
  ready: boolean
  reload: () => Promise<void>
}

/** The shared session-mode status; probed on first use on Windows. */
export function useSessionStatus(platform: string | undefined): SessionState {
  const snap = useSyncExternalStore(subscribe, () => snapshot)
  const windows = platform === 'win32'
  useEffect(() => {
    if (windows && !snapshot.status && !snapshot.loading && !snapshot.error) void probe()
  }, [windows])
  const phase = snap.status ? sessionPhase(snap.status, snap.installed) : undefined
  return { ...snap, phase, ready: phase === 'ready', reload: probe }
}

function lineOf(t: Translate, s: SessionState): string {
  if (s.error) return t('session.line.error', { message: s.error })
  if (!s.status) return t('session.probing')
  switch (s.phase) {
    case 'ready':
      return t('session.line.ready')
    case 'install':
      return s.status.editionKind === 'home' ? t('session.line.install.home') : t('session.line.install.client')
    case 'manual':
      return t('session.line.manual')
    case 'reboot':
      return t('session.line.reboot')
    case 'enable':
      return t('session.line.enable')
    default:
      return t('session.line.unsupported')
  }
}

/** The status pill: ready / needs setup / reboot pending / probe failed. */
export function SessionBadge({ t, state }: { t: Translate; state: SessionState }) {
  const tone = state.error
    ? 'error'
    : !state.status
      ? 'idle'
      : state.phase === 'ready'
        ? 'ok'
        : state.phase === 'reboot'
          ? 'info'
          : 'warn'
  const text = state.error
    ? t('session.badge.error')
    : !state.status
      ? t('session.badge.probing')
      : state.phase === 'ready'
        ? t('session.badge.ready')
        : state.phase === 'reboot'
          ? t('session.badge.reboot')
          : t('session.badge.setup')
  return (
    <span className="envx-sess-badge" data-tone={tone}>
      {tone === 'idle' ? <IconSpinner size={11} /> : <i />}
      {text}
    </span>
  )
}

interface SessionSetupProps {
  t: Translate
  platform: string | undefined
  /** `panel` on the Environments page, `inline` under the desktop choice in the account dialog. */
  variant?: 'panel' | 'inline'
  /** Extra sentence after the action note (the dialog explains that saving now is fine). */
  footnote?: string | undefined
}

/** Readiness of separate-session mode with its single next step and a checklist behind "Details". */
export function SessionSetup({ t, platform, variant = 'panel', footnote }: SessionSetupProps) {
  const state = useSessionStatus(platform)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  if (platform !== 'win32') return null
  const { status, phase } = state

  const run = async (action: 'session.install' | 'session.enable') => {
    setBusy(true)
    setActionError(undefined)
    setNotice(undefined)
    try {
      await call(action)
      if (action === 'session.install') set({ installed: true })
      else setNotice(t('session.done.enable'))
      await probe()
    } catch (e) {
      setActionError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  const primary =
    phase === 'install' ? (
      <button
        type="button"
        className="envx-linkbtn"
        data-primary=""
        disabled={busy}
        onClick={() => void run('session.install')}
      >
        {busy ? <IconSpinner size={14} /> : null}
        {busy ? t('session.working') : t('session.action.install')}
      </button>
    ) : phase === 'enable' ? (
      <button
        type="button"
        className="envx-linkbtn"
        data-primary=""
        disabled={busy}
        onClick={() => void run('session.enable')}
      >
        {busy ? <IconSpinner size={14} /> : null}
        {busy ? t('session.working') : t('session.action.enable')}
      </button>
    ) : phase === 'reboot' || state.error ? (
      <button type="button" className="envx-linkbtn" disabled={state.loading} onClick={() => void state.reload()}>
        {state.loading ? <IconSpinner size={14} /> : <IconRefresh size={14} />}
        {t('session.action.recheck')}
      </button>
    ) : null

  const note =
    phase === 'install' ? t('session.note.adminReboot') : phase === 'enable' ? t('session.note.admin') : undefined

  const checks = status ? sessionChecks(status) : []

  return (
    <section
      className="envx-sess"
      data-variant={variant}
      data-phase={phase ?? 'probing'}
      data-open={open ? '' : undefined}
    >
      <div className="envx-sess-head">
        {variant === 'panel' && (
          <span className="envx-tile" data-kind="winuser">
            <IconDesktopSession size={20} />
          </span>
        )}
        <div className="envx-sess-main">
          {variant === 'panel' && (
            <div className="envx-sess-title">
              <strong>{t('session.title')}</strong>
              <SessionBadge t={t} state={state} />
            </div>
          )}
          <span className="envx-sess-line">{lineOf(t, state)}</span>
        </div>
        <div className="envx-sess-actions">
          {status && (
            <button type="button" className="envx-sess-toggle" aria-expanded={open} onClick={() => setOpen(v => !v)}>
              {open ? t('session.action.hide') : t('session.action.details')}
              <IconChevron size={14} />
            </button>
          )}
          {primary}
        </div>
      </div>

      {(note || footnote) && !open && (
        <div className="envx-sess-note">{[note, footnote].filter(Boolean).join(' ')}</div>
      )}
      {actionError && <div className="envx-error-line">{actionError}</div>}
      {notice && !actionError && <div className="envx-sess-note">{notice}</div>}

      {open && status && (
        <div className="envx-sess-body">
          {variant === 'panel' && <p className="envx-sess-purpose">{t('session.purpose')}</p>}
          <ul className="envx-sess-checks">
            {checks.map(c => (
              <li key={c.id} data-ok={c.ok ? '' : undefined} title={c.reason}>
                <i>{c.ok ? <IconCheck size={11} /> : null}</i>
                <span>{t(`session.check.${c.id}`)}</span>
              </li>
            ))}
          </ul>
          <div className="envx-sess-foot">
            <span>
              {phase === 'install' || phase === 'manual' || phase === 'reboot'
                ? t('session.install.detail', {
                    version: status.termwrap.version ?? '—',
                    files: String(status.termwrap.files.length),
                  })
                : phase === 'enable'
                  ? t('session.enable.detail')
                  : t('session.ready.detail')}
              {status.edition ? ` ${t('session.edition', { edition: status.edition })}` : ''}
            </span>
            {phase !== 'reboot' && !state.error && (
              <button
                type="button"
                className="envx-textbtn"
                data-quiet=""
                disabled={state.loading}
                onClick={() => void state.reload()}
              >
                {t('session.action.recheck')}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
