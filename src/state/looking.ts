import { create } from 'zustand'
import type { Engine } from '../core/engine'
import { LOOK_EVERY_MS } from '../core/sync'

/**
 * Who has which card open (see `look` in sync.ts). Ours is announced while
 * the card dialog is open, the tab is visible and the page was used in the
 * last IDLE_MS, so someone who walked away stops showing. Theirs is kept
 * here per board, card → pubs, for the card tiles and the dialog.
 */
const IDLE_MS = 3 * 60_000

type Looks = Record<string, string[]>

export const useLooks = create<{ boards: Record<string, Looks> }>(() => ({ boards: {} }))

const NONE: string[] = []

/** The other people who have this card open right now. */
export function useViewers(board: string, card: string): string[] {
  return useLooks((s) => s.boards[board]?.[card] ?? NONE)
}

let engine: Engine | null = null
let open: { board: string; card: string } | null = null
let lastInput = Date.now()

/** The card dialog opened, or closed (null). */
export function setOpenCard(target: { board: string; card: string } | null): void {
  open = target
  announce()
}

function announce(): void {
  const active = document.visibilityState === 'visible' && Date.now() - lastInput < IDLE_MS
  engine?.sync.look(open && active ? open : null)
}

function refresh(board: string): void {
  if (!engine) return
  const next = engine.sync.lookers(board)
  const prev = useLooks.getState().boards[board] ?? {}
  // unchanged lists keep their identity: only the cards whose viewers changed re-render
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
  if (!changed) return
  useLooks.setState((s) => {
    const boards = { ...s.boards }
    if (Object.keys(merged).length > 0) boards[board] = merged
    else delete boards[board]
    return { boards }
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
    for (const b of Object.keys(useLooks.getState().boards)) refresh(b)
  }, LOOK_EVERY_MS)
}
