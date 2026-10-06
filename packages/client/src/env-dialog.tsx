import * as React from 'react'
import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { Button, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { call, invalidate, messageOf } from './api.ts'
import type { Translate } from './host-api.ts'
import { IconCheck, IconCopy, IconSpinner, KindIcon } from './icons.tsx'
import type {
  EnvConfigView,
  EnvKind,
  EnvView,
  ReverseRevealView,
  ReverseSettingsView,
  ReverseStatusView,
  TestResultView,
} from './types.ts'

type AddableKind = Exclude<EnvKind, 'local'>
const ADDABLE: AddableKind[] = ['server', 'ssh', 'reverse', 'adb', 'winuser']

/** Same rule as the host's aliasFor(). */
function aliasOf(name: string): string {
  let a =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'env'
  if (!/^[a-z]/.test(a)) a = `env_${a}`
  return a
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="envx-field">
      <label>{label}</label>
      {children}
      {hint && <small>{hint}</small>}
    </div>
  )
}

type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string | number | undefined
  onChange: (value: string) => void
  mono?: boolean
  'data-modal-autofocus'?: string
}

function TextInput({ value, onChange, mono, ...rest }: TextInputProps) {
  return (
    <input
      className="envx-input"
      data-mono={mono ? '' : undefined}
      value={value ?? ''}
      onChange={e => onChange(e.target.value)}
      spellCheck={false}
      autoComplete="off"
      {...rest}
    />
  )
}

const DEFAULTS: Record<AddableKind, EnvConfigView> = {
  server: { port: 7461 },
  ssh: { port: 22 },
  adb: {},
  winuser: {},
  reverse: {},
}

interface EnvDialogProps {
  open: boolean
  environment: EnvView | undefined
  platform: string | undefined
  onClose: () => void
  t: Translate
}

/** Add or edit an environment definition. */
export function EnvDialog({ open, environment, platform, onClose, t }: EnvDialogProps) {
  const editing = !!environment
  const [kind, setKind] = useState<EnvKind | undefined>(environment?.kind)
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [idTouched, setIdTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [config, setConfig] = useState<EnvConfigView>({})
  const [exclusive, setExclusive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | undefined>(undefined)
  const [reveal, setReveal] = useState<ReverseRevealView | undefined>(undefined)

  useEffect(() => {
    if (!open) return
    setKind(environment?.kind)
    setName(environment?.name ?? '')
    setId(environment?.id ?? '')
    setIdTouched(!!environment)
    setDescription(environment?.description ?? '')
    setConfig(environment?.config ?? {})
    setExclusive(environment?.exclusive ?? false)
    setResult(undefined)
    setReveal(undefined)
    setBusy(false)
  }, [open, environment])

  const choose = (k: AddableKind) => {
    setKind(k)
    setConfig({ ...DEFAULTS[k] })
    setExclusive(k === 'adb' || k === 'winuser')
  }

  const set = (key: keyof EnvConfigView, value: string) => setConfig(c => ({ ...c, [key]: value }))
  const effectiveId = idTouched ? id : aliasOf(name || kind || 'env')
  const kinds = ADDABLE.filter(k => k !== 'winuser' || platform === 'win32')

  const valid =
    kind &&
    name.trim() &&
    ((kind === 'server' && (config.url || (config.host && config.port))) ||
      kind === 'reverse' ||
      (kind === 'ssh' && config.host) ||
      (kind === 'adb' && config.serial) ||
      (kind === 'winuser' && config.account))

  const save = async () => {
    setBusy(true)
    setResult(undefined)
    try {
      let saved: EnvView
      if (kind === 'reverse') {
        const r = await call<{ environment: EnvView; reverse?: ReverseRevealView }>('save', {
          environment: { id: effectiveId, name: name.trim(), kind, description, exclusive, config },
        })
        invalidate()
        setIdTouched(true)
        setId(r.environment.id)
        if (r.reverse) setReveal(r.reverse)
        else onClose()
        return
      }
      if (kind === 'winuser' && !editing) {
        saved = (
          await call<{ environment: EnvView }>('winuser.create', { name: config.account, environmentName: name.trim() })
        ).environment
      } else {
        saved = (
          await call<{ environment: EnvView }>('save', {
            environment: { id: effectiveId, name: name.trim(), kind, description, exclusive, config },
          })
        ).environment
      }
      invalidate()
      const test = await call<TestResultView>('test', { id: saved.id })
      invalidate()
      if (test.ok) {
        setResult({
          ok: true,
          text:
            t('status.connected', { ms: test.ms ?? 0 }) +
            (test.info
              ? ` — ${test.info.os}${test.info.arch ? ` · ${test.info.arch}` : ''}${test.info.user ? ` · ${test.info.user}` : ''}`
              : ''),
        })
        setTimeout(onClose, 900)
      } else {
        setResult({ ok: false, text: test.error ?? '' })
        setIdTouched(true)
        setId(saved.id)
      }
    } catch (e) {
      setResult({ ok: false, text: messageOf(e) })
    } finally {
      setBusy(false)
    }
  }

  const footer = kind ? (
    <div className="envx-footer">
      {!editing && (
        <Button
          variant="ghost"
          onClick={() => {
            setKind(undefined)
            setResult(undefined)
          }}
        >
          ‹ {t('field.kind')}
        </Button>
      )}
      <span className="envx-spacer" />
      <Button variant="ghost" onClick={onClose}>
        {t('action.cancel')}
      </Button>
      {reveal ? (
        <Button variant="primary" onClick={onClose}>
          {t('action.done')}
        </Button>
      ) : (
        <Button variant="primary" disabled={!valid || busy} onClick={() => void save()}>
          {busy ? t('action.testing') : kind === 'reverse' ? t('action.save') : t('action.saveAndTest')}
        </Button>
      )}
    </div>
  ) : undefined

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? t('dialog.edit') : t('dialog.add')}
      closeLabel={t('action.close')}
      footer={footer}
      className="envx-dialog"
    >
      {!kind && (
        <div className="envx-kinds">
          {kinds.map(k => (
            <button type="button" key={k} className="envx-kind" data-kind={k} onClick={() => choose(k)}>
              <span className="envx-tile" data-kind={k}>
                <KindIcon kind={k} />
              </span>
              <span>
                <strong>{t(`kind.${k}`)}</strong>
                <span>{t(`kind.${k}.desc`)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {kind && (
        <div className="envx-form" data-kind={kind}>
          <div className="envx-field-row" data-even="">
            <Field label={t('field.name')}>
              <TextInput value={name} onChange={setName} placeholder={t('field.name.ph')} data-modal-autofocus="" />
            </Field>
            <Field label={t('field.id')}>
              <TextInput
                value={effectiveId}
                mono
                disabled={editing}
                onChange={v => {
                  setId(v.replace(/[^A-Za-z0-9_.-]/g, ''))
                  setIdTouched(true)
                }}
              />
            </Field>
          </div>
          {!editing && (
            <small style={{ marginTop: -8, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>
              {t('field.id.hint', { alias: aliasOf(effectiveId) })}
            </small>
          )}

          {kind === 'server' && (
            <>
              <Field label={t('field.url')} hint={t('field.url.hint')}>
                <TextInput
                  value={config.url}
                  onChange={v => set('url', v.trim())}
                  placeholder="wss://env.example.com/dsh-env"
                  mono
                />
              </Field>
              <div className="envx-field-row">
                <Field label={t('field.host')}>
                  <TextInput value={config.host} onChange={v => set('host', v)} placeholder="192.168.1.20" mono />
                </Field>
                <Field label={t('field.port')}>
                  <TextInput
                    value={config.port}
                    onChange={v => set('port', v.replace(/\D/g, ''))}
                    inputMode="numeric"
                    mono
                  />
                </Field>
              </div>
              <Field label={t('field.token')} hint={t('field.token.hint')}>
                <TextInput value={config.token} onChange={v => set('token', v)} type="password" mono />
              </Field>
              <div className="envx-help">
                <strong>{t('server.help.title')}</strong>
                {t('server.help.body')}
                <code>dsh-env-server serve --listen 0.0.0.0:7461 --token-file token.txt</code>
                <code>dsh-env-server serve --listen ws://127.0.0.1:7461/dsh-env --token-file token.txt</code>
              </div>
            </>
          )}

          {kind === 'reverse' && (
            <ReverseSection environment={environment} envId={effectiveId} reveal={reveal} onReveal={setReveal} t={t}>
              <Field label={t('field.cwd')}>
                <TextInput value={config.cwd} onChange={v => set('cwd', v)} placeholder="/home/me/project" mono />
              </Field>
            </ReverseSection>
          )}

          {kind === 'ssh' && (
            <>
              <div className="envx-field-row">
                <Field label={t('field.host')}>
                  <TextInput value={config.host} onChange={v => set('host', v)} placeholder="build.example.com" mono />
                </Field>
                <Field label={t('field.port')}>
                  <TextInput
                    value={config.port}
                    onChange={v => set('port', v.replace(/\D/g, ''))}
                    inputMode="numeric"
                    mono
                  />
                </Field>
              </div>
              <div className="envx-field-row" data-even="">
                <Field label={t('field.username')}>
                  <TextInput value={config.username} onChange={v => set('username', v)} mono />
                </Field>
                <Field label={t('field.password')}>
                  <TextInput value={config.password} onChange={v => set('password', v)} type="password" />
                </Field>
              </div>
              <small style={{ marginTop: -8, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>
                {t('field.password.hint')}
              </small>
              <div className="envx-field-row" data-even="">
                <Field label={t('field.privateKey')}>
                  <TextInput
                    value={config.privateKeyPath}
                    onChange={v => set('privateKeyPath', v)}
                    placeholder={t('field.privateKey.ph')}
                    mono
                  />
                </Field>
                <Field label={t('field.passphrase')}>
                  <TextInput value={config.passphrase} onChange={v => set('passphrase', v)} type="password" />
                </Field>
              </div>
              <Field label={t('field.cwd')}>
                <TextInput value={config.cwd} onChange={v => set('cwd', v)} placeholder="/home/me/project" mono />
              </Field>
              <Field label={t('field.serverPath')} hint={t('field.serverPath.hint')}>
                <TextInput
                  value={config.serverPath}
                  onChange={v => set('serverPath', v)}
                  placeholder="/usr/local/bin/dsh-env-server"
                  mono
                />
              </Field>
            </>
          )}

          {kind === 'adb' && (
            <Field label={t('field.serial')} hint={t('field.serial.hint')}>
              <TextInput value={config.serial} onChange={v => set('serial', v)} placeholder="emulator-5554" mono />
            </Field>
          )}

          {kind === 'winuser' && (
            <>
              <Field label={t('field.account')} hint={t('field.account.hint')}>
                <TextInput
                  value={config.account}
                  disabled={editing}
                  onChange={v => set('account', v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20))}
                  placeholder="dsh-test"
                  mono
                />
              </Field>
              {!editing && (
                <div className="envx-help">
                  <strong>{t('dialog.account.title')}</strong>
                  {t('dialog.account.body')}
                </div>
              )}
            </>
          )}

          <Field label={t('field.description')}>
            <TextInput value={description} onChange={setDescription} />
          </Field>

          <div className="envx-switch-row">
            <div>
              <span>{t('field.exclusive')}</span>
              <small>{t('field.exclusive.hint')}</small>
            </div>
            <Switch checked={exclusive} onChange={setExclusive} label={t('field.exclusive')} />
          </div>

          {result && (
            <div className="envx-result" data-ok={String(result.ok)}>
              {result.ok ? <IconCheck size={16} /> : null}
              <span>{result.text}</span>
            </div>
          )}
          {busy && !result && (
            <div
              className="envx-result"
              data-ok="true"
              style={{ color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)' }}
            >
              <IconSpinner size={16} />
              <span>{t('action.testing')}</span>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

function CopyLine({ label, text, t }: { label: string; text: string; t: Translate }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="envx-field">
      <label>{label}</label>
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <code
          className="envx-input"
          data-mono=""
          style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all' }}
        >
          {text}
        </code>
        <Button
          variant="ghost"
          aria-label={t('action.copy')}
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
        </Button>
      </div>
    </div>
  )
}

interface ReverseSectionProps {
  environment: EnvView | undefined
  envId: string
  reveal: ReverseRevealView | undefined
  onReveal: (r: ReverseRevealView) => void
  t: Translate
  children: ReactNode
}

/** Reverse environments: listener settings, connection state and the one-time connect command. */
function ReverseSection({ environment, envId, reveal, onReveal, t, children }: ReverseSectionProps) {
  const [status, setStatus] = useState<ReverseStatusView | undefined>(undefined)
  const [settings, setSettings] = useState<ReverseSettingsView>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let live = true
    void call<{ status: ReverseStatusView; settings: ReverseSettingsView }>('reverse.settings', {}).then(
      r => {
        if (!live) return
        setStatus(r.status)
        setSettings(r.settings)
      },
      (e: unknown) => live && setError(messageOf(e)),
    )
    return () => {
      live = false
    }
  }, [])

  const apply = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const r = await call<{ status: ReverseStatusView; settings: ReverseSettingsView }>('reverse.settings', {
        settings,
      })
      setStatus(r.status)
      setSettings(r.settings)
      invalidate()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  const rotate = async () => {
    setBusy(true)
    setError(undefined)
    try {
      onReveal((await call<{ reverse: ReverseRevealView }>('reverse.rotate', { id: envId })).reverse)
      invalidate()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  const listenerText = (l: ReverseStatusView['tcp'] | undefined) =>
    !l?.enabled ? t('reverse.listener.off') : l.listening ? t('reverse.listener.on', { port: l.port }) : (l.error ?? '')
  const conn = environment?.connection
  const tcp = settings.tcp ?? {}
  const ws = settings.ws ?? {}

  return (
    <>
      {children}
      <div className="envx-help">
        <strong>{t('reverse.listener.title')}</strong>
        {t('reverse.listener.body')}
      </div>
      <div className="envx-switch-row">
        <div>
          <span>TCP</span>
          <small>{listenerText(status?.tcp)}</small>
        </div>
        <Switch
          checked={!!tcp.enabled}
          onChange={v => setSettings(s => ({ ...s, tcp: { ...s.tcp, enabled: v } }))}
          label="TCP"
        />
      </div>
      {tcp.enabled && (
        <div className="envx-field-row" data-even="">
          <Field label={t('reverse.bind')}>
            <TextInput
              value={tcp.host}
              onChange={v => setSettings(s => ({ ...s, tcp: { ...s.tcp, host: v } }))}
              placeholder="0.0.0.0"
              mono
            />
          </Field>
          <Field label={t('field.port')}>
            <TextInput
              value={tcp.port}
              onChange={v => setSettings(s => ({ ...s, tcp: { ...s.tcp, port: Number(v.replace(/\D/g, '')) } }))}
              inputMode="numeric"
              placeholder="7462"
              mono
            />
          </Field>
        </div>
      )}
      <div className="envx-switch-row">
        <div>
          <span>WebSocket</span>
          <small>{listenerText(status?.ws)}</small>
        </div>
        <Switch
          checked={!!ws.enabled}
          onChange={v => setSettings(s => ({ ...s, ws: { ...s.ws, enabled: v } }))}
          label="WebSocket"
        />
      </div>
      {ws.enabled && (
        <div className="envx-field-row">
          <Field label={t('reverse.bind')}>
            <TextInput
              value={ws.host}
              onChange={v => setSettings(s => ({ ...s, ws: { ...s.ws, host: v } }))}
              placeholder="0.0.0.0"
              mono
            />
          </Field>
          <Field label={t('field.port')}>
            <TextInput
              value={ws.port}
              onChange={v => setSettings(s => ({ ...s, ws: { ...s.ws, port: Number(v.replace(/\D/g, '')) } }))}
              inputMode="numeric"
              placeholder="7463"
              mono
            />
          </Field>
          <Field label={t('reverse.path')}>
            <TextInput
              value={ws.path}
              onChange={v => setSettings(s => ({ ...s, ws: { ...s.ws, path: v } }))}
              placeholder="/dsh-env"
              mono
            />
          </Field>
        </div>
      )}
      <Field label={t('reverse.publicHost')} hint={t('reverse.publicHost.hint', { host: status?.publicHost ?? '' })}>
        <TextInput
          value={settings.publicHost}
          onChange={v => setSettings(s => ({ ...s, publicHost: v }))}
          placeholder={status?.publicHost}
          mono
        />
      </Field>
      <div className="envx-footer" style={{ padding: 0 }}>
        <span className="envx-spacer" />
        {environment && (
          <Button variant="ghost" disabled={busy} onClick={() => void rotate()}>
            {t('reverse.rotate')}
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={() => void apply()}>
          {t('action.apply')}
        </Button>
      </div>
      {environment && (
        <div className="envx-result" data-ok={String(!!conn && conn.idle + conn.active > 0)}>
          <span>
            {conn && conn.idle + conn.active > 0
              ? t('reverse.connected', { peer: conn.peer ?? '', active: conn.active })
              : t('reverse.waiting')}
          </span>
        </div>
      )}
      {reveal && (
        <>
          <div className="envx-help">
            <strong>{t('reverse.command.title')}</strong>
            {reveal.posix ? t('reverse.command.body') : t('reverse.command.noListener')}
          </div>
          {reveal.posix && <CopyLine label={t('reverse.command.posix')} text={reveal.posix} t={t} />}
          {reveal.windows && <CopyLine label={t('reverse.command.windows')} text={reveal.windows} t={t} />}
          <CopyLine label={t('reverse.secret')} text={reveal.secret} t={t} />
        </>
      )}
      {error && (
        <div className="envx-result" data-ok="false">
          <span>{error}</span>
        </div>
      )}
    </>
  )
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => Promise<unknown>
  onClose: () => void
  t: Translate
}

/** Simple confirmation dialog. */
export function ConfirmDialog({ open, title, body, confirmLabel, danger, onConfirm, onClose, t }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (open) {
      setBusy(false)
      setError(undefined)
    }
  }, [open])
  const go = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await onConfirm()
      invalidate()
      onClose()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={t('action.close')}
      className="envx-dialog"
      footer={
        <div className="envx-footer">
          <Button variant="ghost" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void go()}
            style={danger ? { background: 'var(--dsw-alias-state-error-primary)' } : undefined}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <p style={{ margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 13.5, lineHeight: '21px' }}>{body}</p>
      {error && (
        <div className="envx-result" data-ok="false" style={{ marginTop: 12 }}>
          <span>{error}</span>
        </div>
      )}
    </Modal>
  )
}
