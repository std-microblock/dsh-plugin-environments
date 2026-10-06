/**
 * Local declarations for the DSH client host API used by this module.
 *
 * The client services (`slots`, `locale`, `layout`, `uiWorkspace`) are published with large
 * generic typings spread over several packages; only the members this GUI calls are declared here.
 */
import type { ComponentType } from 'react'
import type { Dictionary } from './locales.ts'

export type Dispose = () => void

/** Translate a key of this plugin's namespace, interpolating `{name}` placeholders. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

export interface LocaleService {
  register(ns: string, dictionaries: Record<string, Dictionary>): Dispose
  bind(ns: string): Translate
  subscribe(listener: () => void): Dispose
  getSnapshot(): unknown
}

export interface SlotRegistration {
  name: string
  key?: string
  id?: string
  order?: number
  locale?: string
  label?: () => string
  /** Maps the slot's host value (the session id for `conversation.input.left`) to component props. */
  inject?: (value: string | number | undefined) => Record<string, unknown>
}

export interface SlotsService {
  inject(slot: string, register: () => Dispose | undefined | void): void
  register<P>(registration: SlotRegistration, component: ComponentType<P>): Dispose
}

export interface LayoutService {
  selectPanel(id: string): void
}

export interface UiWorkspaceService {
  startSession(workspaceId: string): void
}

/** The client plugin context. */
export interface ClientContext {
  slots: SlotsService
  locale: LocaleService
  layout: LayoutService
  uiWorkspace: UiWorkspaceService
  effect(fn: () => () => void, label?: string): void
}
