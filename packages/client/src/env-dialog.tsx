import * as React from 'react'
import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { Button, Modal, SegmentedControl, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { call, invalidate, messageOf } from './api.ts'
import type { Translate } from './host-api.ts'
import {
  IconArrowRight,
  IconCheck,
  IconChevron,
  IconCopy,
  IconDesktopPrivate,
  IconDesktopSession,
  IconDesktopShared,
  IconKey,
  IconLocal,
  IconServer,
  IconSpinner,
  KindIcon,
} from './icons.tsx'
import { SessionBadge, SessionSetup, useSessionStatus, type SessionState } from './session-mode.tsx'
import type {
  EnvConfigView,
  EnvKind,
  EnvView,
  LeaseMode,
  ReverseRevealView,
  ReverseSettingsView,
  ReverseStatusView,
  TestResultView,
} from './types.ts'

type AddableKind = Exclude<EnvKind, 'local'>
/** The kind picker. `server` stands for both directions; the form then picks direct or reverse. */
const PICKABLE: AddableKind[] = ['server', 'ssh', 'adb', 'winuser']

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

function Field({ label, hint, children }: { label: string; hint?: string | undefined; children: ReactNode }) {
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

/** A collapsible group: a clickable header with an optional one-line summary of its contents. */
function Disclosure({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string
  summary?: ReactNode
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="envx-disc" data-open={open ? '' : undefined}>
      <button type="button" className="envx-disc-head" aria-expanded={open} onClick={onToggle}>
        <IconChevron size={14} />
        <span className="envx-disc-title">{title}</span>
        {summary && <span className="envx-disc-summary">{summary}</span>}
      </button>
      {open && <div className="envx-disc-body">{children}</div>}
    </div>
  )
}

/** A ready-to-paste command with its own copy button. */
function CommandBlock({ label, text, t }: { label?: string | undefined; text: string; t: Translate }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="envx-cmd">
      {label && <span className="envx-cmd-label">{label}</span>}
      <div className="envx-cmd-body">
        <code>{text}</code>
        <button
          type="button"
          className="envx-cmd-copy"
          data-copied={copied ? '' : undefined}
          aria-label={t('action.copy')}
          onClick={copy}
        >
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          <span>{copied ? t('action.copied') : t('action.copy')}</span>
        </button>
      </div>
    </div>
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
  /** Live environment list (polled by the page), for the connection state of reverse environments. */
  environments?: EnvView[] | undefined
  platform: string | undefined
  /** The plugin's default mount mode (shown for "default"). */
  defaultMountMode?: LeaseMode | undefined
  onClose: () => void
  t: Translate
}

/** Add or edit an environment definition. */
export function EnvDialog({ open, environment, environments, platform, defaultMountMode, onClose, t }: EnvDialogProps) {
  const editing = !!environment
  const [kind, setKind] = useState<EnvKind | undefined>(environment?.kind)
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [idTouched, setIdTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [config, setConfig] = useState<EnvConfigView>({})
  const [addr, setAddr] = useState<'host' | 'url'>('host')
  const [headlessParallel, setHeadlessParallel] = useState(true)
  const [mountMode, setMountMode] = useState<LeaseMode | ''>('')
  const [moreOpen, setMoreOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | undefined>(undefined)
  const [reveal, setReveal] = useState<ReverseRevealView | undefined>(undefined)
  /** Id of a reverse environment saved by this dialog (its live state is looked up by it). */
  const [savedId, setSavedId] = useState<string | undefined>(undefined)
  const session = useSessionStatus(kind === 'winuser' ? platform : undefined)
  const listeners = useReverseListeners(open && kind === 'reverse')
  useEffect(() => {
    if (!open) return
    setKind(environment?.kind)
    setName(environment?.name ?? '')
    setId(environment?.id ?? '')
    setIdTouched(!!environment)
    setDescription(environment?.description ?? '')
    setConfig(environment?.config ?? {})
    setAddr(environment?.config.url ? 'url' : 'host')
    setHeadlessParallel(environment?.headlessParallel ?? true)
    setMountMode(environment?.mountMode ?? '')
    setMoreOpen(false)
    setResult(undefined)
    setReveal(undefined)
    setSavedId(undefined)
    setBusy(false)
  }, [open, environment])

  const choose = (k: AddableKind) => {
    setKind(k)
    setConfig({ ...DEFAULTS[k] })
    setAddr('host')
    setHeadlessParallel(true)
    setMountMode('')
    setResult(undefined)
  }

  /** Switch an unsaved environment server between dialing out and being dialed. */
  const setDirection = (k: 'server' | 'reverse') => {
    if (k === kind) return
    // Never carry a typed server token over into a reverse environment's secret (or back).
    setConfig(c => ({ ...DEFAULTS[k], ...(c.cwd ? { cwd: c.cwd } : {}) }))
    setKind(k)
    setResult(undefined)
  }

  const lease = { headlessParallel, mountMode: mountMode || null }

  const set = (key: keyof EnvConfigView, value: string) => setConfig(c => ({ ...c, [key]: value }))
  const effectiveId = idTouched ? id : aliasOf(name || kind || 'env')
  const kinds = PICKABLE.filter(k => k !== 'winuser' || platform === 'win32')
  const live = environments?.find(e => e.id === (savedId ?? environment?.id)) ?? environment

  /** What a direct server is saved with: only the address form that is shown. */
  const serverConfig = (): EnvConfigView => {
    const { url, host, port, ...rest } = config
    return addr === 'url' ? { ...rest, url } : { ...rest, host, port }
  }

  const valid =
    kind &&
    name.trim() &&
    ((kind === 'server' && (addr === 'url' ? !!config.url : !!(config.host && config.port))) ||
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
        // The target needs something to dial: apply pending listener changes, and switch TCP on
        // when nothing listens yet, so the generated command works without a separate step.
        await listeners.ensure()
        const r = await call<{ environment: EnvView; reverse?: ReverseRevealView }>('save', {
          environment: { id: effectiveId, name: name.trim(), kind, description, ...lease, config },
        })
        invalidate()
        setIdTouched(true)
        setId(r.environment.id)
        setSavedId(r.environment.id)
        if (r.reverse) setReveal(r.reverse)
        else onClose()
        return
      }
      if (kind === 'winuser' && !editing) {
        saved = (
          await call<{ environment: EnvView }>('winuser.create', {
            name: config.account,
            environmentName: name.trim(),
            desktop: config.desktop,
          })
        ).environment
        // The account's environment is created with the defaults; apply the lease settings.
        if (!headlessParallel || mountMode) {
          saved = (
            await call<{ environment: EnvView }>('save', {
              environment: { ...saved, ...lease, config: { account: config.account, desktop: config.desktop } },
            })
          ).environment
        }
      } else {
        saved = (
          await call<{ environment: EnvView }>('save', {
            environment: {
              id: effectiveId,
              name: name.trim(),
              kind,
              description,
              ...lease,
              config: kind === 'server' ? serverConfig() : config,
            },
          })
        ).environment
      }
      invalidate()
      // A separate session cannot come up before the machine is set up for it; a connection
      // test would only fail, so the saved account is reported as waiting instead.
      if (kind === 'winuser' && config.desktop === 'session' && !session.ready) {
        setResult({ ok: true, text: t('desktop.saved.notReady') })
        setTimeout(onClose, 1400)
        return
      }
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

  const primaryLabel = busy
    ? kind === 'reverse'
      ? t('session.working')
      : t('action.testing')
    : kind === 'reverse'
      ? editing
        ? t('action.save')
        : t('action.saveAndGenerate')
      : kind === 'winuser' && config.desktop === 'session' && !session.ready
        ? t('action.save')
        : t('action.saveAndTest')

  const footer = kind ? (
    <div className="envx-footer">
      {!editing && !reveal && (
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
      {!reveal && (
        <Button variant="ghost" onClick={onClose}>
          {t('action.cancel')}
        </Button>
      )}
      {reveal ? (
        <Button variant="primary" onClick={onClose}>
          {t('action.done')}
        </Button>
      ) : (
        <Button
          variant="primary"
          disabled={!valid || busy}
          icon={busy ? <IconSpinner size={16} /> : undefined}
          onClick={() => void save()}
        >
          {primaryLabel}
        </Button>
      )}
    </div>
  ) : undefined

  const moreSummary = [
    headlessParallel ? t('status.shared') : t('status.exclusive'),
    `${t('field.mountMode')} · ${mountMode ? t(`mode.${mountMode}`) : t('field.mountMode.default', { mode: t(`mode.${defaultMountMode ?? 'headless'}`) })}`,
    description.trim(),
  ]
    .filter(Boolean)
    .join(' · ')

  const serverFamily = kind === 'server' || kind === 'reverse'

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
      {kind && reveal && (
        <div className="envx-form" data-kind={kind}>
          <ReverseReveal reveal={reveal} env={live} t={t} />
        </div>
      )}
      {kind && !reveal && (
        <div className="envx-form" data-kind={kind}>
          {serverFamily && (
            <DirectionPicker
              value={kind === 'reverse' ? 'reverse' : 'server'}
              onChange={setDirection}
              locked={editing}
              t={t}
            />
          )}

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
          {!editing && <small className="envx-form-note">{t('field.id.hint', { alias: aliasOf(effectiveId) })}</small>}

          {kind === 'server' && (
            <ServerSection config={config} set={set} addr={addr} onAddr={setAddr} editing={editing} t={t} />
          )}

          {kind === 'reverse' && (
            <ReverseSection
              environment={live}
              editing={editing}
              listeners={listeners}
              onReveal={r => {
                setSavedId(effectiveId)
                setReveal(r)
              }}
              t={t}
            >
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
              <small className="envx-form-note">{t('field.password.hint')}</small>
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
              <Field
                label={t('field.account')}
                hint={editing ? t('field.account.hint') : t('field.account.hint.create')}
              >
                <TextInput
                  value={config.account}
                  disabled={editing}
                  onChange={v => set('account', v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20))}
                  placeholder="dsh-test"
                  mono
                />
              </Field>
              <DesktopModePicker
                value={config.desktop ?? 'shared'}
                onChange={desktop => setConfig(c => ({ ...c, desktop }))}
                session={session}
                platform={platform}
                t={t}
              />
            </>
          )}

          <Disclosure
            title={t('more.title')}
            summary={moreOpen ? undefined : moreSummary}
            open={moreOpen}
            onToggle={() => setMoreOpen(v => !v)}
          >
            <Field label={t('field.description')}>
              <TextInput value={description} onChange={setDescription} />
            </Field>

            <div className="envx-switch-row">
              <div>
                <span>{t('field.headlessParallel')}</span>
                <small>{t('field.headlessParallel.hint')}</small>
              </div>
              <Switch checked={headlessParallel} onChange={setHeadlessParallel} label={t('field.headlessParallel')} />
            </div>

            <Field label={t('field.mountMode')} hint={t('field.mountMode.hint')}>
              <select
                className="envx-input"
                value={mountMode}
                onChange={e =>
                  setMountMode(e.target.value === 'gui' || e.target.value === 'headless' ? e.target.value : '')
                }
              >
                <option value="">
                  {t('field.mountMode.default', { mode: t(`mode.${defaultMountMode ?? 'headless'}`) })}
                </option>
                <option value="headless">
                  {t('mode.headless')} · {t('mode.headless.desc')}
                </option>
                <option value="gui">
                  {t('mode.gui')} · {t('mode.gui.desc')}
                </option>
              </select>
            </Field>
          </Disclosure>

          {result && (
            <div className="envx-result" data-ok={String(result.ok)}>
              {result.ok ? <IconCheck size={16} /> : null}
              <span>{result.text}</span>
            </div>
          )}
          {busy && !result && kind !== 'reverse' && (
            <div className="envx-result" data-ok="pending">
              <IconSpinner size={16} />
              <span>{t('action.testing')}</span>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

/** Environment server: direct (dsh dials the target) or reverse (the target dials in). */
function DirectionPicker({
  value,
  onChange,
  locked,
  t,
}: {
  value: 'server' | 'reverse'
  onChange: (k: 'server' | 'reverse') => void
  locked: boolean
  t: Translate
}) {
  const options = [
    { kind: 'server' as const, key: 'direct' },
    { kind: 'reverse' as const, key: 'reverse' },
  ]
  const move = (e: React.KeyboardEvent) => {
    if (locked) return
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    const next = value === 'server' ? 'reverse' : 'server'
    onChange(next)
    const group = (e.currentTarget as HTMLElement).parentElement
    ;(group?.querySelector(`[data-dir='${next}']`) as HTMLElement | null)?.focus()
  }
  return (
    <div className="envx-field">
      <label id="envx-direction-label">{t('field.direction')}</label>
      <div className="envx-modes" data-cols="2" role="radiogroup" aria-labelledby="envx-direction-label">
        {options.map(({ kind, key }) => {
          const on = value === kind
          return (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              className="envx-mode envx-dir"
              data-dir={kind}
              data-on={on ? '' : undefined}
              disabled={locked && !on}
              title={locked && !on ? t('direction.locked') : undefined}
              onClick={() => onChange(kind)}
              onKeyDown={move}
            >
              <span className="envx-flow" data-dir={kind} aria-hidden="true">
                <span className="envx-flow-node">
                  <IconLocal size={14} />
                  {t('direction.this')}
                </span>
                <span className="envx-flow-arrow">
                  <IconArrowRight size={16} />
                </span>
                <span className="envx-flow-node">
                  <IconServer size={14} />
                  {t('direction.target')}
                </span>
              </span>
              <strong>{t(`direction.${key}`)}</strong>
              <span>{t(`direction.${key}.desc`)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

interface ServerSectionProps {
  config: EnvConfigView
  set: (key: keyof EnvConfigView, value: string) => void
  addr: 'host' | 'url'
  onAddr: (a: 'host' | 'url') => void
  editing: boolean
  t: Translate
}

/** Direct environment server: where it listens, its token, and how to start it. */
function ServerSection({ config, set, addr, onAddr, editing, t }: ServerSectionProps) {
  const [helpOpen, setHelpOpen] = useState(!editing)
  const port = String(config.port || 7461)
  return (
    <>
      <div className="envx-field">
        <div className="envx-field-head">
          <label>{t('field.address')}</label>
          <SegmentedControl
            id="envx-addr"
            className="envx-seg"
            value={addr}
            label={t('field.address')}
            options={[
              { value: 'host', label: t('address.hostPort') },
              { value: 'url', label: t('address.url') },
            ]}
            onChange={onAddr}
          />
        </div>
        {addr === 'host' ? (
          <div className="envx-field-row">
            <TextInput
              value={config.host}
              onChange={v => set('host', v.trim())}
              placeholder="192.168.1.20"
              aria-label={t('field.host')}
              mono
            />
            <TextInput
              value={config.port}
              onChange={v => set('port', v.replace(/\D/g, ''))}
              inputMode="numeric"
              placeholder="7461"
              aria-label={t('field.port')}
              mono
            />
          </div>
        ) : (
          <>
            <TextInput
              value={config.url}
              onChange={v => set('url', v.trim())}
              placeholder="wss://env.example.com/dsh-env"
              aria-label={t('field.url')}
              mono
            />
            <small>{t('field.url.hint')}</small>
          </>
        )}
      </div>
      <Field label={t('field.token')} hint={t('field.token.hint')}>
        <TextInput value={config.token} onChange={v => set('token', v)} type="password" mono />
      </Field>
      <Disclosure title={t('server.help.title')} open={helpOpen} onToggle={() => setHelpOpen(v => !v)}>
        <p className="envx-disc-text">{t('server.help.body')}</p>
        <CommandBlock
          label={t('server.help.tcp')}
          text={`dsh-env-server serve --listen 0.0.0.0:${port} --token-file token.txt`}
          t={t}
        />
        <CommandBlock
          label={t('server.help.ws')}
          text={`dsh-env-server serve --listen ws://127.0.0.1:${port}/dsh-env --token-file token.txt`}
          t={t}
        />
      </Disclosure>
    </>
  )
}

type DesktopMode = 'shared' | 'private' | 'session'
const DESKTOP_MODES: { mode: DesktopMode; Icon: (p: { size?: number }) => React.JSX.Element }[] = [
  { mode: 'shared', Icon: IconDesktopShared },
  { mode: 'private', Icon: IconDesktopPrivate },
  { mode: 'session', Icon: IconDesktopSession },
]

interface DesktopModePickerProps {
  value: DesktopMode
  onChange: (mode: DesktopMode) => void
  session: SessionState
  platform: string | undefined
  t: Translate
}

/** Where the account's windows live: three mutually exclusive choices, described in place. */
function DesktopModePicker({ value, onChange, session, platform, t }: DesktopModePickerProps) {
  const move = (e: React.KeyboardEvent, i: number) => {
    const d =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const next = DESKTOP_MODES[(i + d + DESKTOP_MODES.length) % DESKTOP_MODES.length]
    if (!next) return
    onChange(next.mode)
    const group = (e.currentTarget as HTMLElement).parentElement
    ;(group?.querySelector(`[data-mode='${next.mode}']`) as HTMLElement | null)?.focus()
  }
  return (
    <div className="envx-field">
      <label id="envx-desktop-label">{t('field.desktop')}</label>
      <div className="envx-modes" role="radiogroup" aria-labelledby="envx-desktop-label">
        {DESKTOP_MODES.map(({ mode, Icon }, i) => {
          const on = value === mode
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              className="envx-mode"
              data-mode={mode}
              data-on={on ? '' : undefined}
              onClick={() => onChange(mode)}
              onKeyDown={e => move(e, i)}
            >
              <span className="envx-mode-top">
                <Icon size={18} />
                {mode === 'session' && session.status && session.phase !== 'ready' && (
                  <SessionBadge t={t} state={session} />
                )}
              </span>
              <strong>{t(`desktop.mode.${mode}`)}</strong>
              <span>{t(`desktop.mode.${mode}.desc`)}</span>
            </button>
          )
        })}
      </div>
      {value === 'session' && !session.ready && (
        <SessionSetup t={t} platform={platform} variant="inline" footnote={t('desktop.mode.session.notReady')} />
      )}
    </div>
  )
}

interface ReverseListeners {
  status: ReverseStatusView | undefined
  settings: ReverseSettingsView
  setSettings: React.Dispatch<React.SetStateAction<ReverseSettingsView>>
  /** The edited settings differ from the applied ones. */
  dirty: boolean
  busy: boolean
  error: string | undefined
  apply: () => Promise<void>
  /** Before generating a command: apply pending edits, and switch TCP on if nothing listens. */
  ensure: () => Promise<void>
}

/** The shared reverse listeners (loaded while `active`). */
function useReverseListeners(active: boolean): ReverseListeners {
  const [status, setStatus] = useState<ReverseStatusView | undefined>(undefined)
  const [settings, setSettings] = useState<ReverseSettingsView>({})
  const [applied, setApplied] = useState('{}')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const accept = (r: { status: ReverseStatusView; settings: ReverseSettingsView }) => {
    setStatus(r.status)
    setSettings(r.settings)
    setApplied(JSON.stringify(r.settings))
  }

  useEffect(() => {
    if (!active) return
    let live = true
    setError(undefined)
    void call<{ status: ReverseStatusView; settings: ReverseSettingsView }>('reverse.settings', {}).then(
      r => live && accept(r),
      (e: unknown) => live && setError(messageOf(e)),
    )
    return () => {
      live = false
    }
  }, [active])

  const dirty = JSON.stringify(settings) !== applied

  const push = async (next: ReverseSettingsView) => {
    setBusy(true)
    setError(undefined)
    try {
      accept(
        await call<{ status: ReverseStatusView; settings: ReverseSettingsView }>('reverse.settings', {
          settings: next,
        }),
      )
      invalidate()
    } catch (e) {
      setError(messageOf(e))
      throw e
    } finally {
      setBusy(false)
    }
  }

  return {
    status,
    settings,
    setSettings,
    dirty,
    busy,
    error,
    apply: () => push(settings).catch(() => undefined),
    ensure: async () => {
      if (!status) return
      const any = !!settings.tcp?.enabled || !!settings.ws?.enabled
      if (any && !dirty) return
      await push(any ? settings : { ...settings, tcp: { ...settings.tcp, enabled: true } })
    },
  }
}

function connectionOf(env: EnvView | undefined) {
  const c = env?.connection
  return c && c.idle + c.active > 0 ? c : undefined
}

/** Live "is the target connected" line of a reverse environment. */
function ReverseLive({ env, t }: { env: EnvView | undefined; t: Translate }) {
  const conn = connectionOf(env)
  return (
    <div className="envx-live" data-state={conn ? 'ok' : 'wait'} role="status">
      {conn ? <i /> : <IconSpinner size={14} />}
      <span>
        {conn ? t('reverse.connected', { peer: conn.peer ?? '', active: conn.active }) : t('reverse.waiting')}
      </span>
    </div>
  )
}

/** The one-time secret and the commands that use it, with the live connection state below. */
function ReverseReveal({ reveal, env, t }: { reveal: ReverseRevealView; env: EnvView | undefined; t: Translate }) {
  const [os, setOs] = useState<'posix' | 'windows'>('posix')
  const text = os === 'windows' ? reveal.windows : reveal.posix
  return (
    <>
      <div className="envx-step">
        <span className="envx-step-icon">
          <IconKey size={16} />
        </span>
        <div>
          <strong>{t('reverse.command.title')}</strong>
          <span>{reveal.posix ? t('reverse.command.body') : t('reverse.command.noListener')}</span>
        </div>
      </div>
      {(reveal.posix || reveal.windows) && (
        <div className="envx-field">
          <SegmentedControl
            id="envx-os"
            className="envx-seg"
            value={os}
            label={t('reverse.command.title')}
            options={[
              { value: 'posix', label: t('reverse.command.posix') },
              { value: 'windows', label: t('reverse.command.windows') },
            ]}
            onChange={setOs}
          />
          {text && <CommandBlock text={text} t={t} />}
        </div>
      )}
      <CommandBlock label={t('reverse.secret')} text={reveal.secret} t={t} />
      <ReverseLive env={env} t={t} />
    </>
  )
}

interface ReverseSectionProps {
  environment: EnvView | undefined
  editing: boolean
  listeners: ReverseListeners
  onReveal: (r: ReverseRevealView) => void
  t: Translate
  children: ReactNode
}

/** Reverse environments: connection state, the shared listeners, and the (re)generated command. */
function ReverseSection({ environment, editing, listeners, onReveal, t, children }: ReverseSectionProps) {
  const { status, settings, setSettings } = listeners
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const rotate = async () => {
    if (!environment) return
    setBusy(true)
    setError(undefined)
    try {
      await listeners.ensure()
      onReveal((await call<{ reverse: ReverseRevealView }>('reverse.rotate', { id: environment.id })).reverse)
      invalidate()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  const tcp = settings.tcp ?? {}
  const ws = settings.ws ?? {}
  const numeric = (v: string) => {
    const n = v.replace(/\D/g, '')
    return n ? Number(n) : undefined
  }
  const listenerText = (l: ReverseStatusView['tcp'] | undefined) =>
    !l?.enabled ? t('reverse.listener.off') : l.listening ? t('reverse.listener.on', { port: l.port }) : (l.error ?? '')

  const failures = status
    ? (
        [
          ['TCP', status.tcp],
          ['WebSocket', status.ws],
        ] as const
      ).filter(([, l]) => l.enabled && !l.listening && l.error)
    : []
  const summary = !status ? (
    <IconSpinner size={12} />
  ) : failures.length ? (
    <span data-tone="error">
      {failures.map(([p, l]) => t('reverse.listener.failed', { proto: p, error: l.error ?? '' })).join(' · ')}
    </span>
  ) : !status.tcp.enabled && !status.ws.enabled ? (
    <span data-tone="warn">{t('reverse.listener.autoTcp', { port: tcp.port ?? 7462 })}</span>
  ) : (
    <span>
      {[
        status.tcp.enabled ? `TCP :${status.tcp.port}` : '',
        status.ws.enabled ? `WebSocket :${status.ws.port}${status.ws.path ?? ''}` : '',
      ]
        .filter(Boolean)
        .join(' · ')}
      {' → '}
      {status.publicHost}
    </span>
  )

  return (
    <>
      {editing && <ReverseLive env={environment} t={t} />}
      {children}
      <Disclosure
        title={t('reverse.listener.title')}
        summary={open ? undefined : summary}
        open={open}
        onToggle={() => setOpen(v => !v)}
      >
        <p className="envx-disc-text">{t('reverse.listener.body')}</p>
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
                onChange={v => setSettings(s => ({ ...s, tcp: { ...s.tcp, port: numeric(v) } }))}
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
          <div className="envx-field-row" data-three="">
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
                onChange={v => setSettings(s => ({ ...s, ws: { ...s.ws, port: numeric(v) } }))}
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
        {listeners.dirty && (
          <div className="envx-inline-actions">
            <span>{t('reverse.listener.dirty')}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={listeners.busy}
              icon={listeners.busy ? <IconSpinner size={14} /> : undefined}
              onClick={() => void listeners.apply()}
            >
              {t('action.apply')}
            </Button>
          </div>
        )}
      </Disclosure>

      {editing ? (
        <div className="envx-step">
          <span className="envx-step-icon">
            <IconKey size={16} />
          </span>
          <div>
            <strong>{t('reverse.command.title')}</strong>
            <span>{t('reverse.command.again')}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !environment}
            icon={busy ? <IconSpinner size={14} /> : undefined}
            onClick={() => void rotate()}
          >
            {t('reverse.rotate')}
          </Button>
        </div>
      ) : (
        <div className="envx-step">
          <span className="envx-step-icon">
            <IconKey size={16} />
          </span>
          <div>
            <strong>{t('reverse.next.title')}</strong>
            <span>{t('reverse.next.body')}</span>
          </div>
        </div>
      )}
      {(error || listeners.error) && (
        <div className="envx-result" data-ok="false">
          <span>{error ?? listeners.error}</span>
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
