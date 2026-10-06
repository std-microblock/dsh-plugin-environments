import * as React from 'react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { call, invalidate, useAction, useEnvState } from './api.ts'
import { RemoteBrowser } from './browser.tsx'
import type { Translate } from './host-api.ts'
import { IconCheck, IconEnvironments, IconMount, IconSpinner, KindIcon } from './icons.tsx'
import type { EnvView, StateView } from './types.ts'

function Popover({ anchor, onClose, children }: { anchor: HTMLElement; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | undefined>(undefined)
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const el = ref.current
      const h = el?.offsetHeight ?? 320
      const w = el?.offsetWidth ?? 340
      const above = r.top - 8 - h >= 8
      const top = above ? r.top - 8 - h : Math.min(window.innerHeight - h - 8, r.bottom + 8)
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left))
      setPos({ top: Math.max(8, top), left })
    }
    place()
    const obs = new ResizeObserver(place)
    if (ref.current) obs.observe(ref.current)
    window.addEventListener('resize', place)
    return () => {
      obs.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [anchor])
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (ref.current?.contains(target) || anchor.contains(target)) return
      if (target?.closest?.('[role=dialog],[data-envx-keep]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [anchor, onClose])
  return createPortal(
    <div
      ref={ref}
      className="envx-pop"
      role="dialog"
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
    >
      {children}
    </div>,
    document.body,
  )
}

interface PanelProps {
  sessionId: string
  data: StateView
  t: Translate
  openManager: () => void
  onClose: () => void
}

function Panel({ sessionId, data, t, openManager, onClose }: PanelProps) {
  const [browser, setBrowser] = useState(false)
  const act = useAction()
  const [savedNote, setSavedNote] = useState(false)
  const envs = data.environments
  const byId: Record<string, EnvView | undefined> = Object.fromEntries(envs.map(e => [e.id, e]))
  const s = data.session
  const mount = s?.mount
  const mountEnv = mount ? byId[mount.envId] : undefined
  const locked = !!s?.started
  const borrowable = new Set(s?.borrowable ?? [])
  const candidates = envs.filter(e => e.borrowable !== false)

  const toggle = (id: string) => {
    const next = new Set(borrowable)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    void act.run(() => call('session.set', { sessionId, borrowable: [...next], cwd: s?.cwd }))
  }

  const sourceLabel =
    s?.borrowableSource === 'session'
      ? t('pop.borrow.custom')
      : s?.borrowableSource === 'workspace'
        ? t('pop.borrow.inherit.workspace')
        : t('pop.borrow.inherit.all')

  return (
    <>
      <div className="envx-pop-section">
        <div className="envx-pop-title">
          <span>{t('pop.mount')}</span>
          {mount?.source === 'workspace' && <small>{t('pop.mount.fromWorkspace')}</small>}
          {mount?.source === 'default' && <small>{t('pop.mount.fromDefault')}</small>}
        </div>
        {mount ? (
          <div className="envx-mounted" data-kind={mountEnv?.kind ?? 'server'}>
            <span
              className="envx-tile"
              data-kind={mountEnv?.kind ?? 'server'}
              style={{ width: 30, height: 30, borderRadius: 8 }}
            >
              <KindIcon kind={mountEnv?.kind} size={17} />
            </span>
            <div className="envx-pop-item-main">
              <strong>{mountEnv?.name ?? mount.envId}</strong>
              <span title={s.mountActive?.remoteRoot ?? mount.remoteRoot}>
                {s.mountActive?.remoteRoot ?? mount.remoteRoot ?? ''}
                {!s.mountActive && !s.mountError ? ` · ${t('pop.mount.pending')}` : ''}
              </span>
            </div>
            {!locked && mount.source !== 'workspace' && (
              <button
                type="button"
                className="envx-textbtn"
                data-quiet=""
                disabled={act.busy}
                onClick={() =>
                  // A workspace default is turned off for this session with an explicit `false`.
                  void act.run(() =>
                    call('session.set', { sessionId, mount: mount.source === 'default' ? false : null, cwd: s.cwd }),
                  )
                }
              >
                {mount.source === 'default' ? t('action.dontMount') : t('action.unmount')}
              </button>
            )}
          </div>
        ) : (
          <>
            <p className="envx-pop-hint">{locked ? t('pop.mount.locked') : t('pop.mount.hint')}</p>
            <div className="envx-pop-item">
              <span className="envx-tile" data-kind="local">
                <KindIcon kind="local" size={15} />
              </span>
              <div className="envx-pop-item-main">
                <strong>{t('pop.mount.none')}</strong>
              </div>
            </div>
            {!locked && (
              <div className="envx-pop-foot">
                <button type="button" className="envx-textbtn" onClick={() => setBrowser(true)}>
                  <IconMount size={13} /> {t('pop.mount.pick')}
                </button>
              </div>
            )}
          </>
        )}
        {s?.mountError && (
          <div className="envx-error-line" style={{ marginTop: 6 }}>
            {t('pop.mount.error', { message: s.mountError })}
          </div>
        )}
      </div>

      <div className="envx-pop-section">
        <div className="envx-pop-title">
          <span>{t('pop.borrow')}</span>
          <small>{sourceLabel}</small>
        </div>
        <p className="envx-pop-hint">{t('pop.borrow.hint')}</p>
        {candidates.map(env => {
          const held = (s?.held ?? []).find(h => h.envId === env.id)
          const busyElsewhere = env.status?.busy && !held
          return (
            <div
              key={env.id}
              className="envx-pop-item"
              data-click=""
              data-kind={env.kind}
              role="checkbox"
              aria-checked={borrowable.has(env.id)}
              tabIndex={0}
              onClick={() => toggle(env.id)}
              onKeyDown={e => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault()
                  toggle(env.id)
                }
              }}
            >
              <span className="envx-check" data-on={borrowable.has(env.id) ? '' : undefined}>
                <IconCheck size={12} />
              </span>
              <span className="envx-tile" data-kind={env.kind}>
                <KindIcon kind={env.kind} size={15} />
              </span>
              <div className="envx-pop-item-main">
                <strong>{env.name}</strong>
                <span>
                  {held
                    ? `${t('badge.borrow')} · ${held.alias}`
                    : busyElsewhere
                      ? t('status.busy')
                      : `${t(`kind.${env.kind}`)}${env.description && env.description !== env.name ? ` · ${env.description}` : ''}`}
                </span>
              </div>
              {held && (
                <button
                  type="button"
                  className="envx-textbtn"
                  onClick={e => {
                    e.stopPropagation()
                    void act.run(() => call('lease.release', { leaseId: held.id }))
                  }}
                >
                  {t('action.return')}
                </button>
              )}
            </div>
          )
        })}
        <div className="envx-pop-foot">
          {s?.borrowableSource === 'session' && (
            <button
              type="button"
              className="envx-textbtn"
              data-quiet=""
              onClick={() => void act.run(() => call('session.set', { sessionId, borrowable: null }))}
            >
              {t('pop.borrow.reset')}
            </button>
          )}
          {s?.cwd && s.borrowableSource === 'session' && (
            <button
              type="button"
              className="envx-textbtn"
              data-quiet=""
              onClick={() =>
                void act.run(async () => {
                  await call('workspace.set', { workspacePath: s.cwd, borrowable: [...borrowable] })
                  setSavedNote(true)
                  setTimeout(() => setSavedNote(false), 2000)
                })
              }
            >
              {savedNote ? t('pop.borrow.saved') : t('pop.borrow.saveWorkspace')}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="envx-textbtn"
            onClick={() => {
              onClose()
              openManager()
            }}
          >
            {t('action.manage')}
          </button>
        </div>
        {act.error && (
          <div className="envx-error-line" style={{ marginTop: 6 }}>
            {act.error}
          </div>
        )}
      </div>

      <RemoteBrowser
        open={browser}
        mode="pick"
        environments={envs}
        onClose={() => setBrowser(false)}
        onPicked={({ envId, path }) => {
          setBrowser(false)
          void act.run(() => call('session.set', { sessionId, mount: { envId, remoteRoot: path }, cwd: s?.cwd }))
        }}
        t={t}
      />
    </>
  )
}

/** Compact composer control showing the session's environment state. */
export function EnvironmentChip({
  sessionId,
  t,
  openManager,
}: {
  sessionId: string
  t: Translate
  openManager: () => void
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const { data } = useEnvState(sessionId, { intervalMs: open ? 2500 : 8000 })
  const s = data?.session
  const mount = s?.mount
  const mountEnv = mount ? data?.environments.find(e => e.id === mount.envId) : undefined
  const heldCount = s?.held.length ?? 0
  const label = mount ? (mountEnv?.name ?? mount.envId) : t('chip.label')
  const title = mount
    ? t('chip.mounted', { name: mountEnv?.name ?? mount.envId })
    : heldCount
      ? t('chip.borrowed', { count: heldCount })
      : t('chip.label')

  useEffect(() => {
    if (open) invalidate()
  }, [open])

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="envx-chipbtn"
        data-active={mount ? '' : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={title}
        onClick={() => setOpen(v => !v)}
      >
        {mount ? <KindIcon kind={mountEnv?.kind ?? 'server'} size={16} /> : <IconEnvironments size={16} />}
        <span>{label}</span>
        {heldCount > 0 && <b>{heldCount}</b>}
      </button>
      {open && anchor.current && (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)}>
          {data ? (
            <Panel sessionId={sessionId} data={data} t={t} openManager={openManager} onClose={() => setOpen(false)} />
          ) : (
            <div className="envx-pop-section">
              <IconSpinner size={16} />
            </div>
          )}
        </Popover>
      )}
    </>
  )
}
