import * as React from 'react'
import { useState } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { call, invalidate, useAction, useEnvState } from './api.ts'
import { RemoteBrowser } from './browser.tsx'
import { ConfirmDialog, EnvDialog } from './env-dialog.tsx'
import type { Translate } from './host-api.ts'
import { IconEdit, IconFolder, IconPlug, IconPlus, IconRefresh, IconSpinner, IconTrash, KindIcon } from './icons.tsx'
import type { CreatedWorkspaceView, EnvView, TestResultView } from './types.ts'

export function relativeTime(t: Translate, ms: number): string {
  const d = Date.now() - ms
  if (d < 60000) return t('time.justNow')
  if (d < 3600000) return t('time.minutes', { n: Math.floor(d / 60000) })
  return t('time.hours', { n: Math.floor(d / 3600000) })
}

function target(env: EnvView): string | undefined {
  const c = env.config
  switch (env.kind) {
    case 'server':
      return c.url || `${c.host}:${c.port}`
    case 'ssh':
      return `${c.username ? `${c.username}@` : ''}${c.host}${c.port && Number(c.port) !== 22 ? `:${c.port}` : ''}`
    case 'adb':
      return c.serial
    case 'winuser':
      return c.account
    case 'reverse':
      return env.connection?.peer
    default:
      return env.description
  }
}

interface Status {
  state: 'busy' | 'error' | 'ok' | 'idle'
  text: string
  detail?: string
}

function statusOf(env: EnvView, t: Translate): Status {
  const st = env.status
  if (st?.busy) {
    const who = st.holders?.[0]?.title
    const queue = st.queue?.length ? ` · ${t('status.queue', { count: st.queue.length })}` : ''
    return { state: 'busy', text: (who ? t('status.busyBy', { who }) : t('status.busy')) + queue }
  }
  if (env.kind === 'reverse') {
    const c = env.connection
    return c && c.idle + c.active > 0
      ? { state: 'ok', text: t('status.available'), ...(c.peer ? { detail: c.peer } : {}) }
      : { state: 'idle', text: t('status.offline') }
  }
  if (env.lastError) return { state: 'error', text: t('status.failed'), detail: env.lastError }
  if (env.info || env.kind === 'local' || env.discovered) return { state: 'ok', text: t('status.available') }
  return { state: 'idle', text: t('status.unknown') }
}

interface EnvCardProps {
  env: EnvView
  t: Translate
  onEdit: (env: EnvView) => void
  onDelete: (env: EnvView) => void
  onWorkspace: (env: EnvView) => void
}

function EnvCard({ env, t, onEdit, onDelete, onWorkspace }: EnvCardProps) {
  const test = useAction()
  const status = statusOf(env, t)
  const sub = [t(`kind.${env.kind}`), target(env)].filter(Boolean).join(' · ')
  const info = env.info
  return (
    <article className="envx-card" data-kind={env.kind}>
      <div className="envx-card-head">
        <span className="envx-tile" data-kind={env.kind}>
          <KindIcon kind={env.kind} />
        </span>
        <div className="envx-card-title">
          <strong title={env.name}>{env.name}</strong>
          <span className="envx-sub" title={sub}>
            {sub}
          </span>
        </div>
        <span className="envx-status" data-state={status.state} title={status.detail ?? status.text}>
          <i />
          {status.text}
        </span>
      </div>
      <div className="envx-meta">
        <span className="envx-chip">
          <code>{env.alias}</code>
        </span>
        {info && <span className="envx-chip">{t('info.os', { os: info.os, arch: info.arch || '—' })}</span>}
        {info?.user && <span className="envx-chip">{info.user}</span>}
        <span className="envx-chip">{env.exclusive ? t('status.exclusive') : t('status.shared')}</span>
        {env.discovered && (
          <span className="envx-chip" data-tone="accent">
            {t('status.discovered')}
          </span>
        )}
        {env.builtin && <span className="envx-chip">{t('status.builtin')}</span>}
      </div>
      {(test.error || (status.state === 'error' && status.detail)) && (
        <div className="envx-error-line">{test.error ?? status.detail}</div>
      )}
      <div className="envx-card-foot">
        <button type="button" className="envx-linkbtn" onClick={() => onWorkspace(env)}>
          <IconFolder size={14} />
          {t('action.newWorkspace')}
        </button>
        <button
          type="button"
          className="envx-linkbtn"
          disabled={test.busy}
          onClick={() =>
            void test.run(async () => {
              const r = await call<TestResultView>('test', { id: env.id })
              if (!r.ok) throw new Error(r.error)
            })
          }
        >
          {test.busy ? <IconSpinner size={14} /> : <IconPlug size={14} />}
          {test.busy ? t('action.testing') : t('action.test')}
        </button>
        <span className="envx-spacer" />
        {env.discovered && (
          <Tooltip label={t('action.addDevice')} side="top">
            <button
              type="button"
              className="envx-iconbtn"
              aria-label={t('action.addDevice')}
              onClick={() =>
                void call('save', {
                  environment: {
                    id: env.id,
                    name: env.name,
                    kind: 'adb',
                    config: env.config,
                    description: env.description,
                  },
                }).then(invalidate)
              }
            >
              <IconPlus size={16} />
            </button>
          </Tooltip>
        )}
        {!env.builtin && !env.discovered && (
          <>
            <Tooltip label={t('action.edit')} side="top">
              <button type="button" className="envx-iconbtn" aria-label={t('action.edit')} onClick={() => onEdit(env)}>
                <IconEdit size={16} />
              </button>
            </Tooltip>
            <Tooltip label={t('action.delete')} side="top">
              <button
                type="button"
                className="envx-iconbtn"
                data-danger=""
                aria-label={t('action.delete')}
                onClick={() => onDelete(env)}
              >
                <IconTrash size={16} />
              </button>
            </Tooltip>
          </>
        )}
      </div>
    </article>
  )
}

type DialogState =
  | { type: 'env'; environment?: EnvView }
  | { type: 'delete'; environment: EnvView }
  | { type: 'browser'; envId?: string }
  | undefined

/** The Environments main panel. */
export function EnvironmentsPage({ t, startSession }: { t: Translate; startSession: (workspaceId: string) => void }) {
  const { data, error, loading, refresh } = useEnvState(undefined, { discover: true })
  const [dialog, setDialog] = useState<DialogState>(undefined)
  const refreshing = useAction()

  const envs = data?.environments ?? []
  const byId: Record<string, EnvView | undefined> = Object.fromEntries(envs.map(e => [e.id, e]))
  const workspaces = data?.remoteWorkspaces ?? []
  const leases = data?.leases ?? []

  const onCreated = (value: CreatedWorkspaceView, start: boolean) => {
    setDialog(undefined)
    if (start && value.workspaceId) startSession(value.workspaceId)
  }

  const deleting = dialog?.type === 'delete' ? dialog.environment : undefined

  return (
    <div className="envx-page">
      <div className="envx-scroll">
        <div className="envx-content">
          <header className="envx-heading">
            <div>
              <h1>{t('page.title')}</h1>
              <p>{t('page.subtitle')}</p>
            </div>
            <div className="envx-actions">
              <Tooltip label={t('action.refresh')} side="bottom">
                <button
                  type="button"
                  className="envx-iconbtn"
                  aria-label={t('action.refresh')}
                  onClick={() =>
                    void refreshing.run(async () => {
                      await call('state', { discover: true })
                      refresh()
                    })
                  }
                >
                  {refreshing.busy || (loading && !data) ? <IconSpinner size={16} /> : <IconRefresh size={16} />}
                </button>
              </Tooltip>
              <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setDialog({ type: 'env' })}>
                {t('action.add')}
              </Button>
            </div>
          </header>

          {error && <div className="envx-banner">{t('err.generic', { message: error })}</div>}
          {data?.discovered.adbError && envs.some(e => e.kind === 'adb') && (
            <div className="envx-banner" data-tone="info">
              {t('adb.error', { message: data.discovered.adbError })}
            </div>
          )}

          <section className="envx-section">
            <div className="envx-section-head">
              <h2>
                {t('section.environments')}
                <span className="envx-count">{envs.length}</span>
              </h2>
            </div>
            <div className="envx-grid">
              {envs.map(env => (
                <EnvCard
                  key={env.id}
                  env={env}
                  t={t}
                  onEdit={e => setDialog({ type: 'env', environment: e })}
                  onDelete={e => setDialog({ type: 'delete', environment: e })}
                  onWorkspace={e => setDialog({ type: 'browser', envId: e.id })}
                />
              ))}
              <button
                type="button"
                className="envx-card envx-kind"
                data-dashed=""
                style={{
                  alignItems: 'center',
                  justifyContent: 'center',
                  minHeight: 132,
                  flexDirection: 'column',
                  gap: 6,
                  color: 'var(--dsw-alias-label-tertiary)',
                }}
                onClick={() => setDialog({ type: 'env' })}
              >
                <IconPlus size={20} />
                <span style={{ fontSize: 13 }}>{t('action.add')}</span>
              </button>
            </div>
          </section>

          <section className="envx-section">
            <div className="envx-section-head">
              <div>
                <h2>
                  {t('section.workspaces')}
                  <span className="envx-count">{workspaces.length}</span>
                </h2>
                <p>{t('section.workspaces.hint')}</p>
              </div>
              <button type="button" className="envx-linkbtn" onClick={() => setDialog({ type: 'browser' })}>
                <IconPlus size={14} />
                {t('action.newWorkspace')}
              </button>
            </div>
            {workspaces.length === 0 ? (
              <div className="envx-empty">{t('section.workspaces.empty')}</div>
            ) : (
              <div className="envx-list">
                {workspaces.map(ws => {
                  const env = byId[ws.envId]
                  const workspaceId = ws.workspaceId
                  return (
                    <div className="envx-row" key={ws.id} data-kind={env?.kind ?? 'server'}>
                      <span className="envx-tile" data-kind={env?.kind ?? 'server'}>
                        <IconFolder size={18} />
                      </span>
                      <div className="envx-row-main">
                        <strong>{ws.title}</strong>
                        <span title={ws.root}>{t('ws.root', { env: env?.name ?? ws.envId, root: ws.root })}</span>
                      </div>
                      {workspaceId && (
                        <button type="button" className="envx-linkbtn" onClick={() => startSession(workspaceId)}>
                          {t('action.newSession')}
                        </button>
                      )}
                      <Tooltip label={t('action.remove')} side="top">
                        <button
                          type="button"
                          className="envx-iconbtn"
                          data-danger=""
                          aria-label={t('action.remove')}
                          onClick={() => void call('remoteWorkspace.delete', { id: ws.id }).then(invalidate)}
                        >
                          <IconTrash size={16} />
                        </button>
                      </Tooltip>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section className="envx-section">
            <div className="envx-section-head">
              <h2>
                {t('section.leases')}
                <span className="envx-count">{leases.length}</span>
              </h2>
            </div>
            {leases.length === 0 ? (
              <div className="envx-empty">{t('section.leases.empty')}</div>
            ) : (
              <div className="envx-list">
                {leases.map(l => {
                  const env = byId[l.envId]
                  return (
                    <div className="envx-row" key={l.id} data-kind={env?.kind ?? 'server'}>
                      <span className="envx-tile" data-kind={env?.kind ?? 'server'}>
                        <KindIcon kind={env?.kind} size={18} />
                      </span>
                      <div className="envx-row-main">
                        <strong>{l.name}</strong>
                        <span>
                          {t('lease.session', {
                            id: String(l.owner?.sessionId ?? '')
                              .replace(/^session-/, '')
                              .slice(0, 8),
                          })}
                          {' · '}
                          {relativeTime(t, l.createdAt)}
                          {l.owner?.reason ? ` · ${l.owner.reason}` : ''}
                          {l.tunnels?.length ? ` · ${t('lease.tunnels', { count: l.tunnels.length })}` : ''}
                        </span>
                      </div>
                      <span className="envx-chip" data-tone={l.purpose === 'mount' ? 'accent' : undefined}>
                        {l.purpose === 'mount' ? t('badge.mount') : t('badge.borrow')}
                      </span>
                      <button
                        type="button"
                        className="envx-linkbtn"
                        onClick={() => void call('lease.release', { leaseId: l.id }).then(invalidate)}
                      >
                        {t('action.release')}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      <EnvDialog
        open={dialog?.type === 'env'}
        environment={dialog?.type === 'env' ? dialog.environment : undefined}
        platform={data?.platform}
        onClose={() => setDialog(undefined)}
        t={t}
      />
      <ConfirmDialog
        open={dialog?.type === 'delete'}
        title={t('dialog.delete.title')}
        body={
          deleting?.kind === 'winuser'
            ? t('dialog.account.delete', { name: deleting.config.account ?? '' })
            : t('dialog.delete.body', { name: deleting?.name ?? '' })
        }
        confirmLabel={t('action.delete')}
        danger
        onConfirm={() => {
          if (!deleting) return Promise.resolve()
          return deleting.kind === 'winuser'
            ? call('winuser.delete', { name: deleting.config.account })
            : call('delete', { id: deleting.id })
        }}
        onClose={() => setDialog(undefined)}
        t={t}
      />
      <RemoteBrowser
        open={dialog?.type === 'browser'}
        mode="workspace"
        environments={envs}
        initialEnvId={dialog?.type === 'browser' ? dialog.envId : undefined}
        onClose={() => setDialog(undefined)}
        onCreated={onCreated}
        t={t}
      />
    </div>
  )
}
