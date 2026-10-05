import * as React from 'react'
import { useEffect, useState } from 'react'
import { Button, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { call, invalidate } from './api.js'
import { IconCheck, IconSpinner, KindIcon } from './icons.jsx'

const ADDABLE = ['server', 'ssh', 'adb', 'winuser']

function aliasOf(name) {
  let a = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'env'
  if (!/^[a-z]/.test(a)) a = `env_${a}`
  return a
}

function Field({ label, hint, children }) {
  return (
    <div className="envx-field">
      <label>{label}</label>
      {children}
      {hint && <small>{hint}</small>}
    </div>
  )
}

function TextInput({ value, onChange, mono, ...rest }) {
  return <input className="envx-input" data-mono={mono ? '' : undefined} value={value ?? ''} onChange={e => onChange(e.target.value)} spellCheck={false} autoComplete="off" {...rest} />
}

const DEFAULTS = {
  server: { port: 7461 },
  ssh: { port: 22 },
  adb: {},
  winuser: {},
}

/** Add or edit an environment definition. */
export function EnvDialog({ open, environment, platform, onClose, t }) {
  const editing = !!environment
  const [kind, setKind] = useState(environment?.kind)
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [idTouched, setIdTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [config, setConfig] = useState({})
  const [exclusive, setExclusive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(undefined)

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
    setBusy(false)
  }, [open, environment])

  const choose = k => {
    setKind(k)
    setConfig({ ...DEFAULTS[k] })
    setExclusive(k === 'adb' || k === 'winuser')
  }

  const set = (key, value) => setConfig(c => ({ ...c, [key]: value }))
  const effectiveId = idTouched ? id : aliasOf(name || kind || 'env')
  const kinds = ADDABLE.filter(k => k !== 'winuser' || platform === 'win32')

  const valid = kind && name.trim() && (
    (kind === 'server' && config.host && config.port)
    || (kind === 'ssh' && config.host)
    || (kind === 'adb' && config.serial)
    || (kind === 'winuser' && config.account)
  )

  const save = async () => {
    setBusy(true)
    setResult(undefined)
    try {
      let saved
      if (kind === 'winuser' && !editing) {
        saved = (await call('winuser.create', { name: config.account, environmentName: name.trim() })).environment
      } else {
        saved = (await call('save', { environment: { id: effectiveId, name: name.trim(), kind, description, exclusive, config } })).environment
      }
      invalidate()
      const test = await call('test', { id: saved.id })
      invalidate()
      if (test.ok) {
        setResult({ ok: true, text: t('status.connected', { ms: test.ms }) + (test.info ? ` — ${test.info.os}${test.info.arch ? ` · ${test.info.arch}` : ''}${test.info.user ? ` · ${test.info.user}` : ''}` : '') })
        setTimeout(onClose, 900)
      } else {
        setResult({ ok: false, text: test.error })
        setIdTouched(true)
        setId(saved.id)
      }
    } catch (e) {
      setResult({ ok: false, text: e.message })
    } finally {
      setBusy(false)
    }
  }

  const footer = kind ? (
    <div className="envx-footer">
      {!editing && <Button variant="ghost" onClick={() => { setKind(undefined); setResult(undefined) }}>‹ {t('field.kind')}</Button>}
      <span className="envx-spacer" />
      <Button variant="ghost" onClick={onClose}>{t('action.cancel')}</Button>
      <Button variant="primary" disabled={!valid || busy} onClick={save}>{busy ? t('action.testing') : t('action.saveAndTest')}</Button>
    </div>
  ) : undefined

  return (
    <Modal open={open} onClose={onClose} title={editing ? t('dialog.edit') : t('dialog.add')} closeLabel={t('action.close')} footer={footer} className="envx-dialog">
      {!kind && (
        <div className="envx-kinds">
          {kinds.map(k => (
            <button type="button" key={k} className="envx-kind" data-kind={k} onClick={() => choose(k)}>
              <span className="envx-tile" data-kind={k}><KindIcon kind={k} /></span>
              <span><strong>{t(`kind.${k}`)}</strong><span>{t(`kind.${k}.desc`)}</span></span>
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
              <TextInput value={effectiveId} mono disabled={editing} onChange={v => { setId(v.replace(/[^A-Za-z0-9_.-]/g, '')); setIdTouched(true) }} />
            </Field>
          </div>
          {!editing && <small style={{ marginTop: -8, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>{t('field.id.hint', { alias: aliasOf(effectiveId) })}</small>}

          {kind === 'server' && (
            <>
              <div className="envx-field-row">
                <Field label={t('field.host')}><TextInput value={config.host} onChange={v => set('host', v)} placeholder="192.168.1.20" mono /></Field>
                <Field label={t('field.port')}><TextInput value={config.port} onChange={v => set('port', v.replace(/\D/g, ''))} inputMode="numeric" mono /></Field>
              </div>
              <Field label={t('field.token')} hint={t('field.token.hint')}>
                <TextInput value={config.token} onChange={v => set('token', v)} type="password" mono />
              </Field>
              <div className="envx-help">
                <strong>{t('server.help.title')}</strong>
                {t('server.help.body')}
                <code>dsh-env-server serve --listen 0.0.0.0:7461</code>
              </div>
            </>
          )}

          {kind === 'ssh' && (
            <>
              <div className="envx-field-row">
                <Field label={t('field.host')}><TextInput value={config.host} onChange={v => set('host', v)} placeholder="build.example.com" mono /></Field>
                <Field label={t('field.port')}><TextInput value={config.port} onChange={v => set('port', v.replace(/\D/g, ''))} inputMode="numeric" mono /></Field>
              </div>
              <div className="envx-field-row" data-even="">
                <Field label={t('field.username')}><TextInput value={config.username} onChange={v => set('username', v)} mono /></Field>
                <Field label={t('field.password')}><TextInput value={config.password} onChange={v => set('password', v)} type="password" /></Field>
              </div>
              <small style={{ marginTop: -8, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>{t('field.password.hint')}</small>
              <div className="envx-field-row" data-even="">
                <Field label={t('field.privateKey')}><TextInput value={config.privateKeyPath} onChange={v => set('privateKeyPath', v)} placeholder={t('field.privateKey.ph')} mono /></Field>
                <Field label={t('field.passphrase')}><TextInput value={config.passphrase} onChange={v => set('passphrase', v)} type="password" /></Field>
              </div>
              <Field label={t('field.cwd')}><TextInput value={config.cwd} onChange={v => set('cwd', v)} placeholder="/home/me/project" mono /></Field>
              <Field label={t('field.serverPath')} hint={t('field.serverPath.hint')}>
                <TextInput value={config.serverPath} onChange={v => set('serverPath', v)} placeholder="/usr/local/bin/dsh-env-server" mono />
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
                <TextInput value={config.account} disabled={editing} onChange={v => set('account', v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20))} placeholder="dsh-test" mono />
              </Field>
              {!editing && <div className="envx-help"><strong>{t('dialog.account.title')}</strong>{t('dialog.account.body')}</div>}
            </>
          )}

          <Field label={t('field.description')}><TextInput value={description} onChange={setDescription} /></Field>

          <div className="envx-switch-row">
            <div><span>{t('field.exclusive')}</span><small>{t('field.exclusive.hint')}</small></div>
            <Switch checked={exclusive} onChange={setExclusive} label={t('field.exclusive')} />
          </div>

          {result && (
            <div className="envx-result" data-ok={String(result.ok)}>
              {result.ok ? <IconCheck size={16} /> : null}<span>{result.text}</span>
            </div>
          )}
          {busy && !result && <div className="envx-result" data-ok="true" style={{ color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)' }}><IconSpinner size={16} /><span>{t('action.testing')}</span></div>}
        </div>
      )}
    </Modal>
  )
}

/** Simple confirmation dialog. */
export function ConfirmDialog({ open, title, body, confirmLabel, danger, onConfirm, onClose, t }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(undefined)
  useEffect(() => { if (open) { setBusy(false); setError(undefined) } }, [open])
  const go = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await onConfirm()
      invalidate()
      onClose()
    } catch (e) {
      setError(e.message)
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
      footer={(
        <div className="envx-footer">
          <Button variant="ghost" onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={go} style={danger ? { background: 'var(--dsw-alias-state-error-primary)' } : undefined}>{confirmLabel}</Button>
        </div>
      )}
    >
      <p style={{ margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 13.5, lineHeight: '21px' }}>{body}</p>
      {error && <div className="envx-result" data-ok="false" style={{ marginTop: 12 }}><span>{error}</span></div>}
    </Modal>
  )
}
