// Workspace environment settings: the default environment (mount of new sessions) and the
// default borrowable list of one DSH workspace.
import * as React from 'react'
import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { call, useAction, useEnvState } from './api.ts'
import { isUnavailable } from './binding-logic.ts'
import { RemoteBrowser } from './browser.tsx'
import type { Translate } from './host-api.ts'
import { IconCheck, IconFolder, IconSpinner, KindIcon } from './icons.tsx'
import type { AvailabilityView, BindingView, EnvView } from './types.ts'

export interface WorkspaceEnvDialogProps {
  workspaceId: string
  path?: string | undefined
  title?: string | undefined
  binding: BindingView | undefined
  availability: Record<string, AvailabilityView>
  t: Translate
  onClose: () => void
}

function Dot({ a }: { a: AvailabilityView | undefined }) {
  if (!a || (!isUnavailable(a.state) && a.state !== 'busy')) return null
  return <span className="envx-ws-dot" data-state={a.state} title={a.reason} aria-hidden="true" />
}

export function WorkspaceEnvDialog({
  workspaceId,
  path,
  title,
  binding,
  availability,
  t,
  onClose,
}: WorkspaceEnvDialogProps) {
  const { data } = useEnvState(undefined, { intervalMs: 6000 })
  const act = useAction()
  const remote = binding?.kind === 'remote'
  const [envId, setEnvId] = useState<string | undefined>(binding?.kind === 'default' ? binding.envId : undefined)
  const [remoteRoot, setRemoteRoot] = useState<string | undefined>(
    binding?.kind === 'default' ? binding.remoteRoot : undefined,
  )
  const [borrowable, setBorrowable] = useState<string[] | undefined>(binding?.borrowable)
  const [browser, setBrowser] = useState(false)
  const [loaded, setLoaded] = useState(binding !== undefined)

  // The binding may arrive after the dialog opened (first poll); adopt it once.
  useEffect(() => {
    if (loaded || !binding) return
    setLoaded(true)
    if (binding.kind === 'default') {
      setEnvId(binding.envId)
      setRemoteRoot(binding.remoteRoot)
    }
    setBorrowable(binding.borrowable)
  }, [binding, loaded])

  const envs: EnvView[] = data?.environments ?? []
  const remoteEnv = remote ? envs.find(e => e.id === binding.envId) : undefined
  const candidates = envs.filter(e => e.borrowable !== false)
  const custom = Array.isArray(borrowable)
  const checked = new Set(borrowable ?? candidates.map(e => e.id))

  const toggleBorrowable = (id: string) => {
    const next = new Set(checked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setBorrowable([...next])
  }

  const save = () =>
    act.run(async () => {
      await call('workspace.set', {
        workspaceId,
        workspacePath: path,
        borrowable: borrowable ?? null,
        ...(remote ? {} : { defaultMount: envId ? { envId, remoteRoot } : null }),
      })
      onClose()
    })

  const footer = (
    <div className="envx-footer">
      {act.error && <span className="envx-error-line">{act.error}</span>}
      <span className="envx-spacer" />
      <Button variant="ghost" onClick={onClose}>
        {t('action.cancel')}
      </Button>
      <Button variant="primary" disabled={act.busy || !data} onClick={() => void save()}>
        {t('action.save')}
      </Button>
    </div>
  )

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={t('ws.dialog.title', { name: title ?? binding?.remoteWorkspace?.title ?? '' })}
        closeLabel={t('action.close')}
        footer={footer}
        className="envx-dialog-wide"
      >
        <div className="envx-wsd" data-envx-keep="">
          {!data ? (
            <IconSpinner size={18} />
          ) : (
            <>
              <section className="envx-wsd-section">
                <h3>{t('ws.dialog.default')}</h3>
                {remote ? (
                  <>
                    <p className="envx-pop-hint">{t('ws.dialog.remoteHint')}</p>
                    <div className="envx-pop-item" data-kind={remoteEnv?.kind}>
                      <span className="envx-tile" data-kind={remoteEnv?.kind}>
                        <KindIcon kind={remoteEnv?.kind} size={15} />
                      </span>
                      <div className="envx-pop-item-main">
                        <strong>{remoteEnv?.name ?? binding.envId}</strong>
                        <span>{binding.remoteRoot}</span>
                      </div>
                      <Dot a={binding.envId ? availability[binding.envId] : undefined} />
                    </div>
                  </>
                ) : (
                  <>
                    <p className="envx-pop-hint">{t('ws.dialog.defaultHint')}</p>
                    <div role="radiogroup" aria-label={t('ws.dialog.default')}>
                      <div
                        className="envx-pop-item"
                        data-click=""
                        role="radio"
                        aria-checked={!envId}
                        tabIndex={0}
                        onClick={() => setEnvId(undefined)}
                        onKeyDown={e => {
                          if (e.key === ' ' || e.key === 'Enter') {
                            e.preventDefault()
                            setEnvId(undefined)
                          }
                        }}
                      >
                        <span className="envx-check" data-on={!envId ? '' : undefined}>
                          <IconCheck size={12} />
                        </span>
                        <div className="envx-pop-item-main">
                          <strong>{t('ws.dialog.none')}</strong>
                          <span>{t('ws.dialog.noneHint')}</span>
                        </div>
                      </div>
                      {envs.map(env => {
                        const on = env.id === envId
                        const pick = () => {
                          if (env.id !== envId) setRemoteRoot(undefined)
                          setEnvId(env.id)
                        }
                        return (
                          <div
                            key={env.id}
                            className="envx-pop-item"
                            data-click=""
                            data-kind={env.kind}
                            role="radio"
                            aria-checked={on}
                            tabIndex={0}
                            onClick={pick}
                            onKeyDown={e => {
                              if (e.key === ' ' || e.key === 'Enter') {
                                e.preventDefault()
                                pick()
                              }
                            }}
                          >
                            <span className="envx-check" data-on={on ? '' : undefined}>
                              <IconCheck size={12} />
                            </span>
                            <span className="envx-tile" data-kind={env.kind}>
                              <KindIcon kind={env.kind} size={15} />
                            </span>
                            <div className="envx-pop-item-main">
                              <strong>{env.name}</strong>
                              <span>
                                {on
                                  ? (remoteRoot ?? t('ws.dialog.envCwd'))
                                  : `${t(`kind.${env.kind}`)}${env.description && env.description !== env.name ? ` · ${env.description}` : ''}`}
                              </span>
                            </div>
                            <Dot a={availability[env.id]} />
                            {on && (
                              <button
                                type="button"
                                className="envx-textbtn"
                                onClick={e => {
                                  e.stopPropagation()
                                  setBrowser(true)
                                }}
                              >
                                <IconFolder size={13} /> {t('ws.dialog.pickRoot')}
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </section>

              <section className="envx-wsd-section">
                <h3>
                  {t('pop.borrow')}
                  <small>{custom ? t('ws.dialog.borrow.custom') : t('pop.borrow.inherit.all')}</small>
                </h3>
                <p className="envx-pop-hint">{t('ws.dialog.borrowHint')}</p>
                {candidates.map(env => (
                  <div
                    key={env.id}
                    className="envx-pop-item"
                    data-click=""
                    data-kind={env.kind}
                    role="checkbox"
                    aria-checked={checked.has(env.id)}
                    tabIndex={0}
                    onClick={() => toggleBorrowable(env.id)}
                    onKeyDown={e => {
                      if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault()
                        toggleBorrowable(env.id)
                      }
                    }}
                  >
                    <span className="envx-check" data-on={checked.has(env.id) ? '' : undefined}>
                      <IconCheck size={12} />
                    </span>
                    <span className="envx-tile" data-kind={env.kind}>
                      <KindIcon kind={env.kind} size={15} />
                    </span>
                    <div className="envx-pop-item-main">
                      <strong>{env.name}</strong>
                      <span>{t(`kind.${env.kind}`)}</span>
                    </div>
                  </div>
                ))}
                {custom && (
                  <div className="envx-pop-foot">
                    <button
                      type="button"
                      className="envx-textbtn"
                      data-quiet=""
                      onClick={() => setBorrowable(undefined)}
                    >
                      {t('pop.borrow.reset')}
                    </button>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </Modal>
      <RemoteBrowser
        open={browser}
        mode="pick"
        environments={envs.filter(e => e.id === envId)}
        initialEnvId={envId}
        initialPath={remoteRoot}
        onClose={() => setBrowser(false)}
        onPicked={({ envId: picked, path: p }) => {
          setBrowser(false)
          setEnvId(picked)
          setRemoteRoot(p)
        }}
        t={t}
      />
    </>
  )
}
