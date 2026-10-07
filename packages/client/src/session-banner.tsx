// Session-mode banner: says whether this machine can give every isolated account its own real
// Windows session, and offers the one-click TermWrap install when something is missing.
//
// TermWrap patches the loaded Terminal Services image in memory (it is MIT, shipped in the clear
// with its licence and hashes); Windows only picks it up at start-up, so a reboot is always part
// of the flow.
import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { call, invalidate, messageOf } from './api.ts'
import type { Translate } from './host-api.ts'

export interface SessionStatusView {
  ok: boolean
  ready: boolean
  missing: string[]
  reasons: string[]
  edition?: string
  termsrv: { version: string | null; wrapperInstalled: boolean }
  rdp: { listening: boolean; service: string }
  sessions: { id: number; name: string; state: string }[]
  termwrap: {
    present: boolean
    version: string | null
    license: boolean
    files: { name: string; bytes: number }[]
  }
}

export interface SessionBannerProps {
  t: Translate
  platform: string | undefined
}

export function SessionBanner({ t, platform }: SessionBannerProps) {
  const [status, setStatus] = useState<SessionStatusView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [installed, setInstalled] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatus(await call<SessionStatusView>('session.status'))
      setError(undefined)
    } catch (e) {
      setError(messageOf(e))
    }
  }, [])

  useEffect(() => {
    if (platform !== 'win32') return
    void load()
  }, [platform, load])

  if (platform !== 'win32') return null
  if (error) return <div className="envx-banner">{t('session.error', { message: error })}</div>
  if (!status) return null
  if (status.ready) {
    return (
      <div className="envx-banner" data-tone="info">
        {t('session.ready')}
      </div>
    )
  }

  const install = async () => {
    setBusy(true)
    try {
      await call('session.install')
      setInstalled(true)
      invalidate()
      await load()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="envx-banner" data-tone="info">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <strong>{t('session.title')}</strong>
        <span>{t('session.body')}</span>
        <ul style={{ margin: 0, paddingInlineStart: 18 }}>
          {status.reasons.map(reason => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        {installed ? (
          <span>{t('session.reboot')}</span>
        ) : status.termwrap.present ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Button variant="primary" disabled={busy} onClick={() => void install()}>
              {busy ? t('session.installing') : t('session.install')}
            </Button>
            <span className="envx-help" style={{ margin: 0 }}>
              {t('session.install.hint', {
                version: status.termwrap.version ?? '—',
                files: String(status.termwrap.files.length),
              })}
            </span>
          </div>
        ) : (
          <span className="envx-help" style={{ margin: 0 }}>
            {t('session.noPayload')}
          </span>
        )}
      </div>
    </div>
  )
}
