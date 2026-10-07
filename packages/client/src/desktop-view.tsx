// Live view of an environment's desktop, shown from the Environments page.
//
// One frame is one poll of the host's `desktop.frame` action, which asks the environment for a
// downscaled screenshot. A private desktop (a Windows account with its own desktop) renders
// through the same path as any other environment, so this works for both desktop modes.
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { call, messageOf } from './api.ts'
import type { Translate } from './host-api.ts'
import type { EnvView } from './types.ts'

/** Answer of `desktop.frame`. */
export interface DesktopFrameView {
  mime: string
  data: string
  width: number
  height: number
  /** Name of the private desktop the frame came from, when the environment has one. */
  desktop: string | null
  cursor: { x: number; y: number } | null
  at: number
}

/** Poll interval: a few frames per second is enough to watch progress without flooding. */
const INTERVAL_MS = 250

export interface DesktopViewProps {
  env: EnvView
  t: Translate
  onClose: () => void
}

export function DesktopView({ env, t, onClose }: DesktopViewProps) {
  const [frame, setFrame] = useState<DesktopFrameView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [paused, setPaused] = useState(false)
  const [fps, setFps] = useState(0)
  const times = useRef<number[]>([])

  useEffect(() => {
    if (paused) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const tick = async () => {
      try {
        const next = await call<DesktopFrameView>('desktop.frame', { envId: env.id, maxWidth: 1100 }, controller.signal)
        if (disposed) return
        setFrame(next)
        setError(undefined)
        const now = Date.now()
        times.current = [...times.current.filter(at => now - at < 2000), now]
        setFps(Math.round((times.current.length / 2) * 10) / 10)
      } catch (e) {
        if (disposed || controller.signal.aborted) return
        setError(messageOf(e))
      }
      if (!disposed) timer = setTimeout(() => void tick(), INTERVAL_MS)
    }
    void tick()
    return () => {
      disposed = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [env.id, paused])

  const desktop = frame?.desktop ?? (env.config.desktop === 'private' ? t('desktop.mode.private') : undefined)
  return (
    <Modal
      open
      onClose={onClose}
      title={t('desktop.title', { name: env.name })}
      closeLabel={t('action.close')}
      className="envx-dialog envx-desktop"
      footer={
        <div className="envx-footer">
          <span className="envx-chip" data-tone={desktop ? 'accent' : undefined}>
            {desktop ?? t('desktop.mode.shared')}
          </span>
          {frame && <span className="envx-chip">{t('desktop.size', { w: frame.width, h: frame.height })}</span>}
          {!paused && fps > 0 && <span className="envx-chip">{t('desktop.fps', { fps: String(fps) })}</span>}
          <span className="envx-spacer" />
          <Button variant="ghost" onClick={() => setPaused(p => !p)}>
            {paused ? t('action.resume') : t('action.pause')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('action.close')}
          </Button>
        </div>
      }
    >
      <div className="envx-desktop-frame">
        {frame ? (
          <img
            alt={t('desktop.title', { name: env.name })}
            src={`data:${frame.mime};base64,${frame.data}`}
            style={{ width: '100%', display: 'block', borderRadius: 6 }}
          />
        ) : (
          <div className="envx-empty">{error ?? t('desktop.connecting')}</div>
        )}
      </div>
      {frame && error && (
        <div className="envx-result" data-ok="false">
          {error}
        </div>
      )}
      {frame && !error && (
        <div className="envx-help" style={{ marginTop: 8 }}>
          {t('desktop.hint')}
        </div>
      )}
    </Modal>
  )
}
