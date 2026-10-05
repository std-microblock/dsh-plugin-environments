import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { call, invalidate } from './api.js'
import { IconFile, IconFolder, IconHome, IconPlus, IconRefresh, IconSpinner, IconUp } from './icons.jsx'

function formatSize(n) {
  if (n === undefined || n === null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function baseName(p) {
  const parts = String(p).split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/**
 * Remote directory browser.
 * mode "workspace": pick a directory and create a remote workspace from it.
 * mode "pick": return the chosen { envId, path } through onPicked.
 */
export function RemoteBrowser({ open, mode = 'workspace', environments, initialEnvId, initialPath, onClose, onPicked, onCreated, t }) {
  const [envId, setEnvId] = useState(initialEnvId)
  const [listing, setListing] = useState(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(undefined)
  const [pathText, setPathText] = useState('')
  const [title, setTitle] = useState('')
  const [titleTouched, setTitleTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [newFolder, setNewFolder] = useState(undefined)
  const seq = useRef(0)

  const load = useCallback(async (id, path) => {
    if (!id) return
    const mine = ++seq.current
    setLoading(true)
    setError(undefined)
    try {
      const value = await call('fs.list', { envId: id, path })
      if (mine !== seq.current) return
      setListing(value)
      setPathText(value.path)
    } catch (e) {
      if (mine !== seq.current) return
      setError(e.message)
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const id = initialEnvId ?? environments[0]?.id
    setEnvId(id)
    setListing(undefined)
    setTitle('')
    setTitleTouched(false)
    setNewFolder(undefined)
    load(id, initialPath)
  }, [open, initialEnvId, initialPath]) // eslint-disable-line react-hooks/exhaustive-deps

  const env = environments.find(e => e.id === envId)
  const current = listing?.path
  const derivedTitle = current && env ? `${baseName(current)} @ ${env.name}` : ''
  const effectiveTitle = titleTouched ? title : derivedTitle

  const changeEnv = id => {
    setEnvId(id)
    setListing(undefined)
    load(id, undefined)
  }

  const join = name => {
    const sep = listing?.sep ?? '/'
    return current.endsWith(sep) ? `${current}${name}` : `${current}${sep}${name}`
  }

  const createFolder = async () => {
    const name = (newFolder ?? '').trim()
    if (!name) return setNewFolder(undefined)
    try {
      await call('fs.mkdir', { envId, path: join(name) })
      setNewFolder(undefined)
      load(envId, join(name))
    } catch (e) {
      setError(e.message)
    }
  }

  const confirm = async startSession => {
    if (!current) return
    if (mode === 'pick') {
      onPicked?.({ envId, path: current })
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const value = await call('remoteWorkspace.create', { envId, root: current, title: effectiveTitle })
      invalidate()
      onCreated?.(value, startSession)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const dirs = (listing?.entries ?? []).filter(e => e.type === 'dir')
  const files = (listing?.entries ?? []).filter(e => e.type !== 'dir')

  const footer = (
    <div className="envx-footer">
      {mode === 'workspace' && (
        <input
          className="envx-input"
          style={{ flex: 1, minWidth: 0 }}
          value={effectiveTitle}
          placeholder={t('browser.workspaceName')}
          aria-label={t('browser.workspaceName')}
          onChange={e => { setTitle(e.target.value); setTitleTouched(true) }}
        />
      )}
      {mode !== 'workspace' && <span className="envx-spacer" />}
      <Button variant="ghost" onClick={onClose}>{t('action.cancel')}</Button>
      {mode === 'workspace' && <Button variant="outline" disabled={!current || busy} onClick={() => confirm(false)}>{t('browser.create')}</Button>}
      <Button variant="primary" disabled={!current || busy} onClick={() => confirm(true)}>
        {mode === 'workspace' ? t('browser.createAndOpen') : t('action.choose')}
      </Button>
    </div>
  )

  return (
    <Modal open={open} onClose={onClose} title={mode === 'workspace' ? t('browser.title.workspace') : t('browser.title')} closeLabel={t('action.close')} footer={footer} className="envx-dialog-wide">
      <div className="envx-browser">
        <div className="envx-browser-bar">
          <select className="envx-input" value={envId ?? ''} aria-label={t('browser.env')} onChange={e => changeEnv(e.target.value)}>
            {environments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <div className="envx-crumbs">
            <input
              value={pathText}
              aria-label={t('browser.path')}
              spellCheck={false}
              onChange={e => setPathText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') load(envId, pathText.trim() || undefined) }}
            />
          </div>
          <button type="button" className="envx-iconbtn" title={t('action.up')} aria-label={t('action.up')} disabled={!listing?.parent} onClick={() => load(envId, listing.parent)}><IconUp size={16} /></button>
          <button type="button" className="envx-iconbtn" title={t('action.home')} aria-label={t('action.home')} disabled={!listing?.home} onClick={() => load(envId, listing.home)}><IconHome size={16} /></button>
          <button type="button" className="envx-iconbtn" title={t('action.newFolder')} aria-label={t('action.newFolder')} disabled={!current} onClick={() => setNewFolder('')}><IconPlus size={16} /></button>
          <button type="button" className="envx-iconbtn" title={t('action.refresh')} aria-label={t('action.refresh')} onClick={() => load(envId, current)}><IconRefresh size={16} /></button>
        </div>
        <div className="envx-browser-list" role="list">
          {loading && !listing && <div className="envx-browser-state"><IconSpinner size={16} />{t('browser.loading')}</div>}
          {error && <div className="envx-browser-state" style={{ color: 'var(--dsw-alias-state-error-primary)', flexDirection: 'column' }}>
            <span>{error}</span>
            <button type="button" className="envx-textbtn" onClick={() => load(envId, listing?.path)}>{t('action.retry')}</button>
          </div>}
          {!error && listing && (
            <>
              {newFolder !== undefined && (
                <div className="envx-entry" data-type="dir">
                  <IconFolder size={16} />
                  <input
                    className="envx-input"
                    style={{ height: 26 }}
                    autoFocus
                    value={newFolder}
                    placeholder={t('browser.folderName')}
                    onChange={e => setNewFolder(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') { e.stopPropagation(); setNewFolder(undefined) } }}
                    onBlur={createFolder}
                  />
                </div>
              )}
              {dirs.map(e => (
                <button type="button" key={`d:${e.name}`} className="envx-entry" data-type="dir" onClick={() => load(envId, join(e.name))}>
                  <IconFolder size={16} /><span>{e.name}</span>
                </button>
              ))}
              {files.map(e => (
                <div key={`f:${e.name}`} className="envx-entry" data-type="file">
                  <IconFile size={16} /><span>{e.name}</span><em>{formatSize(e.size)}</em>
                </div>
              ))}
              {dirs.length === 0 && files.length === 0 && newFolder === undefined && <div className="envx-browser-state">{t('browser.empty')}</div>}
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
