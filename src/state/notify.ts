import { create } from 'zustand'
import type { AppliedOp, BoardView } from '../core/board'
import type { Engine } from '../core/engine'
import { mentionedPubs, plainMentions } from '../core/mentions'
import { translate, type TKey } from '../ui/i18n'
import { navigate, toast, useApp } from './store'

/**
 * Browser notifications about what other people change on a board. What to
 * be told about is chosen per board and kept on this device only
 * (localStorage), never written to a log or sent to anyone. With no server
 * to push from, they come while the app runs in a tab, from the changes sync
 * brings in (the engine's `activity` event).
 */

export interface NotifyPrefs {
  /** every change on the board */
  all: boolean
  /** every change to the cards in these columns */
  columns: string[]
  /** cards assigned to me */
  assigned: boolean
  /** cards I created, edited or commented on */
  involved: boolean
  /** comments that mention me */
  mentions: boolean
}

export const DEFAULT_PREFS: NotifyPrefs = { all: false, columns: [], assigned: true, involved: true, mentions: true }

type Permission = NotificationPermission | 'unsupported'

const supported = typeof window !== 'undefined' && 'Notification' in window
const permission = (): Permission => (supported ? Notification.permission : 'unsupported')

export const useNotify = create<{
  permission: Permission
  /** boards whose choices were changed in this session; the rest are read from storage */
  prefs: Record<string, NotifyPrefs>
  /** a card to open, from a notification that was clicked */
  open: { board: string; card: string } | null
}>(() => ({ permission: permission(), prefs: {}, open: null }))

const storageKey = (board: string) => `lawha:notify:${board}`

export function prefsFor(board: string): NotifyPrefs {
  const set = useNotify.getState().prefs[board]
  if (set) return set
  try {
    const raw = localStorage.getItem(storageKey(board))
    if (!raw) return DEFAULT_PREFS
    const p = JSON.parse(raw) as Partial<Record<keyof NotifyPrefs, unknown>>
    const flag = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
    return {
      all: flag(p.all, DEFAULT_PREFS.all),
      columns: Array.isArray(p.columns) ? p.columns.filter((c): c is string => typeof c === 'string') : [],
      assigned: flag(p.assigned, DEFAULT_PREFS.assigned),
      involved: flag(p.involved, DEFAULT_PREFS.involved),
      mentions: flag(p.mentions, DEFAULT_PREFS.mentions),
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function useNotifyPrefs(board: string): NotifyPrefs {
  return useNotify((s) => s.prefs[board]) ?? prefsFor(board)
}

export function setNotifyPrefs(board: string, patch: Partial<NotifyPrefs>): void {
  const next = { ...prefsFor(board), ...patch }
  try {
    localStorage.setItem(storageKey(board), JSON.stringify(next))
  } catch {
    // not persisted: it still holds for this session
  }
  useNotify.setState((s) => ({ prefs: { ...s.prefs, [board]: next } }))
}

export async function askPermission(): Promise<void> {
  if (!supported) return
  try {
    await Notification.requestPermission()
  } catch {
    // an old Safari takes a callback instead; the state is read back below either way
  }
  useNotify.setState({ permission: permission() })
}

// ---- what a change says ----

export interface Note {
  card: string | null
  text: string
  mention: boolean
  /** the envelope it came from: the notification's tag */
  id: string
}

const MAX_TEXT = 140
const MAX_SINGLE = 3

/** What `me` is told about `items`, the ops that took `before` to `after`: one note per card at most. */
export function notesFor(items: AppliedOp[], before: BoardView, after: BoardView, me: string, prefs: NotifyPrefs): Note[] {
  const lang = useApp.getState().lang
  const t = (key: TKey, vars?: Record<string, string | number>) => translate(lang, key, vars)
  const nameOf = (pub: string) => after.profiles.get(pub) || pub.slice(0, 8)
  const cardOf = (id: string) => after.cards.get(id) ?? before.cards.get(id)
  const colName = (id: string) => [...after.columns, ...after.archivedColumns].find((c) => c.id === id)?.name ?? ''
  const colsOf = (id: string) => [after.cards.get(id)?.col, before.cards.get(id)?.col].filter((c): c is string => !!c)

  const involved = new Set<string>()
  if (prefs.involved) {
    for (const o of after.ops) {
      if (o.author !== me) continue
      if (o.op.k === 'card.create' || o.op.k === 'card.update') involved.add(o.op.id)
      if (o.op.k === 'comment.add' || o.op.k === 'entry.set' || o.op.k === 'attach.add') involved.add(o.op.card)
    }
  }
  const wants = (card: string, cols: string[]) => {
    if (prefs.all || cols.some((c) => prefs.columns.includes(c))) return true
    if (prefs.assigned && (after.cards.get(card)?.assignees.includes(me) || before.cards.get(card)?.assignees.includes(me))) return true
    return prefs.involved && involved.has(card)
  }

  const notes: Note[] = []
  for (const { id, author, op } of items) {
    const who = nameOf(author)
    const add = (card: string | null, key: TKey, vars: Record<string, string> = {}, mention = false) =>
      notes.push({ id, card, mention, text: t(key, { who, card: card ? (cardOf(card)?.title ?? '') : '', ...vars }) })
    switch (op.k) {
      case 'card.create':
        if (wants(op.id, [op.col])) add(op.id, 'nfAdded', { column: colName(op.col) })
        break
      case 'card.update': {
        if (!wants(op.id, colsOf(op.id))) break
        const assignedMe = op.assignees?.includes(me) && !before.cards.get(op.id)?.assignees.includes(me)
        add(op.id, assignedMe ? 'nfAssignedYou' : op.archived === true ? 'nfArchived' : op.archived === false ? 'nfRestored' : 'nfEdited')
        break
      }
      case 'card.move':
        for (const mv of op.moves) {
          const from = before.cards.get(mv.id)?.col
          // a new place in the same column is only a reorder
          if (from !== mv.col && wants(mv.id, [mv.col, ...(from ? [from] : [])])) {
            notes.push({ id, card: mv.id, mention: false, text: t('nfMoved', { who, card: cardOf(mv.id)?.title ?? '', column: colName(mv.col) }) })
          }
        }
        break
      case 'card.moveOut':
        for (const c of op.ids) if (wants(c, colsOf(c))) notes.push({ id, card: c, mention: false, text: t('nfMovedOut', { who, card: cardOf(c)?.title ?? '' }) })
        break
      case 'comment.add': {
        // comments copied along with a card moved in from another board are not new
        if (op.imported) break
        let text = plainMentions(op.text, (p) => after.profiles.get(p)).replace(/\s+/g, ' ').trim()
        if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 1) + '…'
        if (prefs.mentions && mentionedPubs(op.text).has(me)) add(op.card, 'nfMentioned', { text }, true)
        else if (wants(op.card, colsOf(op.card))) add(op.card, 'nfCommented', { text })
        break
      }
      case 'entry.set':
      case 'attach.remove':
        if (wants(op.card, colsOf(op.card))) add(op.card, 'nfEdited')
        break
      case 'attach.add':
        if (wants(op.card, colsOf(op.card))) add(op.card, 'nfAttached', { name: op.name })
        break
      case 'board.update':
      case 'column.create':
      case 'column.update':
      case 'label.set':
      case 'field.set':
        if (prefs.all) add(null, 'nfBoard')
        break
    }
  }

  // one note per card (and one for the board itself): a mention first, else the first change
  const byTarget = new Map<string, Note>()
  for (const n of notes) {
    const k = n.card ?? ''
    const had = byTarget.get(k)
    if (!had || (n.mention && !had.mention)) byTarget.set(k, n)
  }
  return [...byTarget.values()]
}

// ---- showing them ----

const ICON = `${import.meta.env.BASE_URL}icons/icon-192.png`

async function show(title: string, body: string, tag: string, data: { board: string; card: string | null }): Promise<void> {
  const opts: NotificationOptions = { body, tag, icon: ICON, data, lang: useApp.getState().lang }
  try {
    // the only way on Android, and a click then reaches sw.js
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg?.active) {
      await reg.showNotification(title, opts)
      return
    }
  } catch {
    // fall back to a page notification
  }
  try {
    const n = new Notification(title, opts)
    n.onclick = () => {
      window.focus()
      openTarget(data)
      n.close()
    }
  } catch {
    // this browser shows none from a page
  }
}

function openTarget(data: { board?: unknown; card?: unknown }): void {
  if (typeof data.board !== 'string') return
  navigate({ name: 'board', id: data.board })
  if (typeof data.card === 'string') useNotify.setState({ open: { board: data.board, card: data.card } })
}

function looking(board: string): boolean {
  const route = useApp.getState().route
  return document.visibilityState === 'visible' && document.hasFocus() && route.name === 'board' && route.id === board
}

let started = false

export function startNotifications(engine: Engine): void {
  if (started) return
  started = true
  engine.events.on('activity', ({ board, before, items }) => {
    const after = engine.view(board)
    if (!after) return
    const notes = notesFor(items, before, after, engine.identity.pub, prefsFor(board))
    if (notes.length === 0) return
    // the board is on screen: the changes show there, and a mention as a toast
    if (looking(board)) {
      for (const n of notes) if (n.mention) toast(n.text)
      return
    }
    if (permission() !== 'granted') return
    const title = after.name || engine.boardName(board)
    if (notes.length > MAX_SINGLE) {
      const names = new Intl.ListFormat(useApp.getState().lang).format(
        [...new Set(items.map((o) => after.profiles.get(o.author) || o.author.slice(0, 8)))],
      )
      void show(title, translate(useApp.getState().lang, 'nfMany', { n: notes.length, names }), `${board}:many`, { board, card: null })
      return
    }
    for (const n of notes) void show(title, n.text, n.id, { board, card: n.card })
  })
  // a click on a notification shown by sw.js comes back here
  navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { lawha?: unknown; board?: unknown; card?: unknown } | null
    if (d?.lawha === 'open') openTarget(d)
  })
  // allowed or blocked in the browser's settings meanwhile
  addEventListener('focus', () => useNotify.setState({ permission: permission() }))
}
