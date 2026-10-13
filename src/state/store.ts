import { create } from 'zustand'
import { randomBytes } from '@noble/hashes/utils.js'
import { toB64url } from '../core/b64'
import {
  getDeviceRecord,
  getIdentityRecord,
  openLawhaDb,
  putDeviceRecord,
  putIdentityRecord,
  type LawhaDb,
} from '../core/db'
import {
  exportIdentity,
  generateIdentity,
  importIdentity,
  recordNeedsPassphrase,
  toIdentityRecord,
  unlockIdentity,
} from '../core/identity'
import { clearSession, createSession, getSessionExpiry, loadSession } from '../core/session'
import { Engine } from '../core/engine'
import type { StrategyState } from '../core/events'
import type { Identity } from '../core/types'

export type Route =
  | { name: 'home' }
  | { name: 'board'; id: string }
  | { name: 'members'; id: string }
  | { name: 'contacts' }
  | { name: 'security' }
  | { name: 'join'; code: string }

export type Phase = 'loading' | 'fresh' | 'locked' | 'ready' | 'other-tab'

export const LANGS = ['en', 'sv', 'es', 'fr', 'ar'] as const
export type Lang = (typeof LANGS)[number]

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

interface AppState {
  phase: Phase
  identity: Identity | null
  lang: Lang
  route: Route
  /** workspace whose boards the sidebar shows; null = personal boards */
  ws: string | null
  /** bumped whenever any board re-folds; components re-read views off this */
  version: number
  peers: Record<string, { state: StrategyState; peerCount: number }>
  toasts: Toast[]
  /** multi-select on the open board */
  selection: string[]
  /** a member's join request seen in a room we serve: board → pubs waiting */
  waiting: Record<string, string[]>
}

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem('lawha-lang') as Lang | null
    if (saved && (LANGS as readonly string[]).includes(saved)) return saved
    const nav = navigator.language.slice(0, 2) as Lang
    return (LANGS as readonly string[]).includes(nav) ? nav : 'en'
  } catch {
    return 'en'
  }
}

function applyDir(lang: Lang): void {
  if (typeof document === 'undefined') return
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
  document.documentElement.lang = lang
}

function savedWs(): string | null {
  try {
    return localStorage.getItem('lawha-ws')
  } catch {
    return null
  }
}

export const useApp = create<AppState>(() => ({
  phase: 'loading',
  identity: null,
  lang: detectLang(),
  route: routeFromHash(),
  ws: savedWs(),
  version: 0,
  peers: {},
  toasts: [],
  selection: [],
  waiting: {},
}))

export function setLang(lang: Lang): void {
  useApp.setState({ lang })
  try {
    localStorage.setItem('lawha-lang', lang)
  } catch {
    // private mode etc. — the choice just won't persist
  }
  applyDir(lang)
}

export function setWorkspace(ws: string | null): void {
  useApp.setState({ ws })
  try {
    if (ws) localStorage.setItem('lawha-ws', ws)
    else localStorage.removeItem('lawha-ws')
  } catch {
    // not persisted
  }
}

// ---- routing (hash based, so it works from file:// and GitHub Pages) ----

function routeFromHash(): Route {
  if (typeof location === 'undefined') return { name: 'home' }
  const h = location.hash.replace(/^#\/?/, '')
  const [head, ...rest] = h.split('/')
  if (head === 'b' && rest[0]) return { name: 'board', id: rest[0] }
  if (head === 'm' && rest[0]) return { name: 'members', id: rest[0] }
  if (head === 'contacts') return { name: 'contacts' }
  if (head === 'security') return { name: 'security' }
  if (head === 'join') return { name: 'join', code: rest.join('/') }
  return { name: 'home' }
}

function hashFor(r: Route): string {
  switch (r.name) {
    case 'board':
      return `#/b/${r.id}`
    case 'members':
      return `#/m/${r.id}`
    case 'contacts':
      return '#/contacts'
    case 'security':
      return '#/security'
    case 'join':
      return r.code ? `#/join/${r.code}` : '#/join'
    default:
      return '#/'
  }
}

export function navigate(route: Route): void {
  useApp.setState({ route, selection: [] })
  if (typeof history !== 'undefined' && location.hash !== hashFor(route)) {
    history.pushState(null, '', hashFor(route))
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => useApp.setState({ route: routeFromHash(), selection: [] }))
}

// ---- toasts ----

let toastSeq = 0
export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastSeq
  useApp.setState((s) => ({ toasts: [...s.toasts, { id, text, kind }].slice(-4) }))
  setTimeout(() => useApp.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 6000)
}

// ---- database (reopened transparently when iOS drops it) ----

let db: LawhaDb | null = null
let opening: Promise<LawhaDb> | null = null

function openDb(): Promise<LawhaDb> {
  if (db) return Promise.resolve(db)
  if (opening) return opening
  opening = openLawhaDb('lawha', () => {
    // WebKit (every iOS browser) drops the connection when the tab is
    // backgrounded or under memory pressure; reconnect for the next caller.
    db = null
    opening = null
    void openDb()
  }).then((opened) => {
    db = opened
    opening = null
    return opened
  })
  return opening
}

export function getDb(): LawhaDb {
  if (!db) throw new Error('db not ready')
  return db
}

// ---- engine ----

let engine: Engine | null = null
let dev = ''

export function getEngine(): Engine {
  if (!engine) throw new Error('not unlocked')
  return engine
}

export function me(): Identity {
  const id = useApp.getState().identity
  if (!id) throw new Error('no identity')
  return id
}

/** Hold the single-writer lock for this install, or report another tab has it. */
function acquireWriterLock(): Promise<boolean> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks
  if (!locks) return Promise.resolve(true)
  return new Promise((resolve) => {
    void locks.request('lawha-writer', { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false)
        return undefined
      }
      resolve(true)
      // hold it for the life of the tab
      return new Promise<void>(() => undefined)
    })
  })
}

export async function initApp(): Promise<void> {
  applyDir(useApp.getState().lang)
  if (!(await acquireWriterLock())) {
    useApp.setState({ phase: 'other-tab' })
    return
  }
  const conn = await openDb()
  let device = await getDeviceRecord(conn)
  if (!device) {
    device = { id: 'self', dev: toB64url(randomBytes(16)) }
    await putDeviceRecord(conn, device)
  }
  dev = device.dev

  const record = await getIdentityRecord(conn)
  if (!record) {
    useApp.setState({ phase: 'fresh' })
  } else if (recordNeedsPassphrase(record)) {
    const resumed = await loadSession(conn).catch(() => null)
    if (resumed && resumed.pub === record.pub) await ready(resumed)
    else useApp.setState({ phase: 'locked' })
  } else {
    await ready(await unlockIdentity(record))
  }
}

let onReady: (engine: Engine) => void = () => undefined
export function setOnReady(fn: (engine: Engine) => void): void {
  onReady = fn
}

async function ready(identity: Identity): Promise<void> {
  engine = new Engine(getDb, identity, dev)
  // deferred: engine.view() may refold (and emit) while a component renders,
  // and React forbids updating the store mid-render; also coalesces bursts
  let bumpQueued = false
  const bump = () => {
    if (bumpQueued) return
    bumpQueued = true
    queueMicrotask(() => {
      bumpQueued = false
      useApp.setState((s) => ({ version: s.version + 1 }))
    })
  }
  engine.events.on('board-changed', bump)
  engine.events.on('boards-changed', bump)
  engine.events.on('peer-authed', ({ board, pub, member }) => {
    if (member) return
    useApp.setState((s) => {
      const list = s.waiting[board] ?? []
      return list.includes(pub) ? s : { waiting: { ...s.waiting, [board]: [...list, pub].slice(-20) } }
    })
  })
  // dev-only handle for debugging from the console / e2e
  if (import.meta.env.DEV) (window as unknown as { __lawha: Engine }).__lawha = engine
  await engine.loadAll()
  // a workspace we no longer follow is not a valid filter
  const ws = useApp.getState().ws
  if (ws && !engine.records().some((r) => r.id === ws)) setWorkspace(null)
  useApp.setState({ identity, phase: 'ready' })
  try {
    void navigator.storage?.persist?.()
  } catch {
    // best effort
  }
  onReady(engine)
}

export function peerStatus(strategy: string, state: StrategyState, peerCount: number): void {
  useApp.setState((s) => ({ peers: { ...s.peers, [strategy]: { state, peerCount } } }))
}

// ---- onboarding ----

/** Generate but do NOT persist — the UI shows the backup string first. */
export function prepareIdentity(): { identity: Identity; backup: string } {
  const identity = generateIdentity()
  return { identity, backup: exportIdentity(identity) }
}

export async function commitIdentity(identity: Identity, passphrase?: string, rememberMs = 0): Promise<void> {
  await putIdentityRecord(getDb(), await toIdentityRecord(identity, passphrase || undefined))
  if (passphrase && rememberMs > 0) await createSession(getDb(), identity, rememberMs)
  await ready(identity)
}

export async function importAndCommit(backup: string, passphrase?: string, rememberMs = 0): Promise<void> {
  await commitIdentity(importIdentity(backup), passphrase, rememberMs)
}

export async function unlock(passphrase: string, rememberMs = 0): Promise<void> {
  const record = await getIdentityRecord(getDb())
  if (!record) throw new Error('no identity record')
  const identity = await unlockIdentity(record, passphrase)
  if (rememberMs > 0) await createSession(getDb(), identity, rememberMs)
  await ready(identity)
}

export async function identityEncrypted(): Promise<boolean> {
  const record = await getIdentityRecord(getDb()).catch(() => undefined)
  return !!record && recordNeedsPassphrase(record)
}

export function sessionExpiry(): Promise<number | null> {
  return getSessionExpiry(getDb()).catch(() => null)
}

/** Drop the session and lock: reload so the in-memory key and network go away. */
export async function endSession(): Promise<void> {
  await clearSession(getDb()).catch(() => undefined)
  location.reload()
}

/** Public, shareable base URL, or null when the page is not hosted. */
export function shareableBase(): string | null {
  if (typeof location === 'undefined') return null
  const { protocol, hostname } = location
  if (protocol === 'file:') return null
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return import.meta.env.DEV ? location.origin + location.pathname : null
  }
  return location.origin + location.pathname
}
