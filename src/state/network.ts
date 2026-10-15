import { NetworkManager, ALL_STRATEGIES, type Strategy } from '../core/net'
import type { Engine, RoomSpec } from '../core/engine'
import { netStatus, useApp } from './store'
import { iceServers } from './turn'

/**
 * Which board rooms to be in. Every joined room costs relay subscriptions
 * (and tracker announces for torrent), so join lazily:
 *   - the open board (all strategies) and its company workspace
 *   - every company workspace we are on: coworkers meet there, and that
 *     connection carries every board they share (see sync.ts)
 *   - boards written to in the last 10 minutes (so writes get out)
 *   - one personal board shared with others, picked by rendezvous hashing
 *     over 90 s slots, so two people who share boards land in the same room
 *     at the same time even when neither has one open
 * Capped at MAX_ROOMS. Torrent is used only for the open board.
 *
 * Env overrides (optional):
 *   VITE_STRATEGIES=mqtt   limit discovery strategies
 *   VITE_LOCAL_BROKER=1    mqtt → ws://localhost:9001 (offline testing)
 */

const MAX_ROOMS = 5
const RECENT_MS = 10 * 60_000
const SLOT_MS = 90_000
const TICK_MS = 2_000
const LIGHT: readonly Strategy[] = ['nostr', 'mqtt']

/** FNV-1a: an even spread is all the rendezvous needs */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

let started = false
let current: NetworkManager | null = null

/** Reconnect every room (after the TURN setting changed). */
export function restartNetwork(): void {
  current?.restart()
}

export function startNetwork(engine: Engine): void {
  if (started) return
  started = true
  const env = import.meta.env as Record<string, string | undefined>

  const net = new NetworkManager(
    {
      onPeer: (ch) => engine.sync.onPeerJoin(ch),
      onPeerGone: (key) => engine.sync.onPeerLeave(key),
      onMessage: (ch, action, payload) => void engine.sync.onMessage(ch, action, payload),
      onPiece: (ch, data, meta) => void engine.sync.onPiece(ch, data, meta),
    },
    {
      strategies: env.VITE_STRATEGIES?.split(','),
      mqttUrls: env.VITE_LOCAL_BROKER ? ['ws://localhost:9001'] : undefined,
      iceServers,
    },
  )
  current = net
  net.events.on('relays', (relays) => netStatus({ relays }))
  net.events.on('unreachable', () => netStatus({ unreachableAt: Date.now() }))
  engine.events.on('presence', () => {
    netStatus({ peers: engine.sync.installs() })
    net.checkRelays()
  })

  const strategiesFor = (board: string): readonly Strategy[] => {
    const r = useApp.getState().route
    return r.name === 'board' && r.id === board ? ALL_STRATEGIES : LIGHT
  }

  /** this slot's meeting room among the personal boards we share with someone */
  const rendezvous = (slot: number): string | null => {
    const me = engine.identity.pub
    let best: string | null = null
    let bestHash = Infinity
    for (const r of engine.records()) {
      if (r.hidden || engine.wsOf(r.id) !== null) continue
      const v = engine.view(r.id)
      if (!v || v.kind !== 'board' || v.myRole === 'none') continue
      if (![...v.resolved.roles.keys()].some((pub) => pub !== me)) continue
      const h = hash(`${r.id}:${slot}`)
      if (h < bestHash) [best, bestHash] = [r.id, h]
    }
    return best
  }

  let slot = Math.floor(Date.now() / SLOT_MS)

  const desired = (): RoomSpec[] => {
    const st = useApp.getState()
    const ordered: string[] = []
    const add = (b: string | null | undefined) => {
      if (b && !ordered.includes(b)) ordered.push(b)
    }
    if (st.route.name === 'board' || st.route.name === 'members') {
      add(st.route.id)
      add(engine.wsOf(st.route.id))
    }
    add(st.ws)
    for (const r of engine.records()) {
      if (r.kind !== 'workspace' || r.hidden) continue
      const v = engine.view(r.id)
      // not synced yet (an invite) or still on the roster
      if (!v || v.owner === null || v.myRole !== 'none') add(r.id)
    }
    const now = Date.now()
    for (const r of engine.records()) if (now - r.lastWriteAt < RECENT_MS) add(r.id)
    add(rendezvous(slot))
    const specs: RoomSpec[] = []
    for (const b of ordered) {
      const spec = engine.roomSpec(b)
      if (spec) specs.push(spec)
      if (specs.length >= MAX_ROOMS) break
    }
    return specs
  }

  const reconcile = () => {
    const want = desired()
    const wantIds = new Set(want.map((s) => s.board))
    for (const b of net.joinedBoards()) if (!wantIds.has(b)) net.leave(b)
    // a rotated company secret moves a board's room: join() leaves the old one
    for (const spec of want) net.join(spec, strategiesFor(spec.board))
  }

  reconcile()
  useApp.subscribe((s, prev) => {
    if (s.route !== prev.route || s.ws !== prev.ws) reconcile()
  })
  engine.events.on('acl-changed', () => reconcile())
  engine.events.on('boards-changed', () => reconcile())
  engine.events.on('local-append', () => reconcile())

  setInterval(() => {
    net.checkRelays()
    const now = Math.floor(Date.now() / SLOT_MS)
    if (now !== slot) {
      slot = now
      reconcile()
    }
  }, TICK_MS)
  setInterval(() => void engine.sync.resyncAll(), 60_000)

  const wake = () => {
    reconcile()
    net.checkRelays()
    void engine.sync.resyncAll()
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wake()
  })
  addEventListener('online', wake)
}
