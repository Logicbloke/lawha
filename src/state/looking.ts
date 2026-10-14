import { create } from 'zustand'
import type { Engine } from '../core/engine'
import { LOOK_EVERY_MS } from '../core/sync'

/**
 * Who has which card open (see `look` in sync.ts). Ours is announced while
 * the card dialog is open, the tab is visible and the page was used in the
 * last IDLE_MS, so someone who walked away stops showing. Theirs is kept
 * here per board, card → pubs, for the card tiles and the dialog.
 *
 * The same message says whether we are writing a comment there: from the
 * first keystroke in a non-empty comment box until TYPING_IDLE_MS without
 * one, the box is emptied (sent) or the card closes.
 */
const IDLE_MS = 3 * 60_000
const TYPING_IDLE_MS = 6_000

type Looks = Record<string, string[]>

export const useLooks = create<{ boards: Record<string, Looks>; writing: Record<string, Looks> }>(() => ({
  boards: {},
  writing: {},
}))

const NONE: string[] = []

/** The other people who have this card open right now. */
export function useViewers(board: string, card: string): string[] {
  return useLooks((s) => s.boards[board]?.[card] ?? NONE)
}

/** The other people writing a comment on this card right now. */
export function useWriters(board: string, card: string): string[] {
  return useLooks((s) => s.writing[board]?.[card] ?? NONE)
}

let engine: Engine | null = null
let open: { board: string; card: string } | null = null
let lastInput = Date.now()
let typing = false
let typingTimer: ReturnType<typeof setTimeout> | undefined

/** The card dialog opened, or closed (null). */
export function setOpenCard(target: { board: string; card: string } | null): void {
  open = target
  clearTimeout(typingTimer)
  typing = false
  announce()
}

/** The comment box of the open card changed; `draft` is what it holds now. */
export function noteTyping(draft: string): void {
  clearTimeout(typingTimer)
  const now = draft.trim() !== ''
  if (now) typingTimer = setTimeout(() => setTyping(false), TYPING_IDLE_MS)
  setTyping(now)
}

function setTyping(on: boolean): void {
  if (on === typing) return
  typing = on
  announce()
}

function announce(): void {
  const active = document.visibilityState === 'visible' && Date.now() - lastInput < IDLE_MS
  engine?.sync.look(open && active ? { ...open, typing } : null)
}

/** `next`, reusing the lists in `prev` that did not change (only those cards re-render); `prev` itself if none did. */
function merge(prev: Looks, next: Looks): Looks {
  const merged: Looks = {}
  let changed = Object.keys(prev).length !== Object.keys(next).length
  for (const [card, pubs] of Object.entries(next)) {
    const old = prev[card]
    if (old && old.length === pubs.length && old.every((p, i) => p === pubs[i])) merged[card] = old
    else {
      merged[card] = pubs
      changed = true
    }
  }
  return changed ? merged : prev
}

function put(all: Record<string, Looks>, board: string, looks: Looks): Record<string, Looks> {
  const next = { ...all }
  if (Object.keys(looks).length > 0) next[board] = looks
  else delete next[board]
  return next
}

function refresh(board: string): void {
  if (!engine) return
  const s = useLooks.getState()
  const viewing = s.boards[board] ?? {}
  const writing = s.writing[board] ?? {}
  const v = merge(viewing, engine.sync.lookers(board))
  const w = merge(writing, engine.sync.writers(board))
  if (v === viewing && w === writing) return
  useLooks.setState({
    boards: v === viewing ? s.boards : put(s.boards, board, v),
    writing: w === writing ? s.writing : put(s.writing, board, w),
  })
}

export function startLooking(e: Engine): void {
  if (engine) return
  engine = e
  // a burst of messages (or a connection dropping) becomes one refresh per board
  const queued = new Set<string>()
  e.events.on('looks', ({ board }) => {
    if (queued.size === 0) {
      queueMicrotask(() => {
        for (const b of queued) refresh(b)
        queued.clear()
      })
    }
    queued.add(board)
  })

  const used = () => {
    const wasIdle = Date.now() - lastInput >= IDLE_MS
    lastInput = Date.now()
    if (wasIdle && open) announce()
  }
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
    addEventListener(type, used, { passive: true, capture: true })
  }
  document.addEventListener('visibilitychange', announce)

  setInterval(() => {
    // repeat ours (or notice we went idle); drop theirs that lapsed
    announce()
    for (const b of Object.keys(useLooks.getState().boards)) refresh(b) // writers are viewers too
  }, LOOK_EVERY_MS)
}
