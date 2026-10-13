import { NetworkManager, ALL_STRATEGIES, type Strategy } from '../core/net'
import type { Engine, RoomSpec } from '../core/engine'
import { peerStatus, useApp } from './store'

/**
 * Which board rooms to be in. Every joined room costs relay subscriptions
 * (and tracker announces for torrent), so join lazily:
 *   - the open board (all strategies) and its company workspace
 *   - the selected workspace (its roster can change any time)
 *   - boards written to in the last 10 minutes (so writes get out)
 *   - one background board at a time, rotating every 90 s
 * Capped at MAX_ROOMS. Torrent is used only for the open board.
 *
 * Env overrides (optional):
 *   VITE_STRATEGIES=mqtt   limit discovery strategies
 *   VITE_LOCAL_BROKER=1    mqtt → ws://localhost:9001 (offline testing)
 */

const MAX_ROOMS = 5
const RECENT_MS = 10 * 60_000
const SWEEP_MS = 90_000
const LIGHT: readonly Strategy[] = ['nostr', 'mqtt']

let started = false

export function startNetwork(engine: Engine): void {
  if (started) return
  started = true
  const env = import.meta.env as Record<string, string | undefined>

  const net = new NetworkManager(
    {
      onPeer: (ch) => engine.sync.onPeerJoin(ch),
      onPeerGone: (key) => engine.sync.onPeerLeave(key),
      onMessage: (ch, action, payload) => void engine.sync.onMessage(ch, action, payload),
    },
    {
      strategies: env.VITE_STRATEGIES?.split(','),
      mqttUrls: env.VITE_LOCAL_BROKER ? ['ws://localhost:9001'] : undefined,
    },
  )
  net.events.on('peer-status', (p) => peerStatus(p.strategy, p.state, p.peerCount))

  let sweepIndex = 0
  let sweepBoard: string | null = null
  const current = new Map<string, string>() // board → roomId it is joined under

  const strategiesFor = (board: string): readonly Strategy[] => {
    const r = useApp.getState().route
    return r.name === 'board' && r.id === board ? ALL_STRATEGIES : LIGHT
  }

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
    const now = Date.now()
    for (const r of engine.records()) if (now - r.lastWriteAt < RECENT_MS) add(r.id)
    add(sweepBoard)
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
    for (const b of net.joinedBoards()) {
      if (!wantIds.has(b)) {
        net.leave(b)
        current.delete(b)
      }
    }
    for (const spec of want) {
      // a rotated company secret moves the room: leave the old one first
      if (current.get(spec.board) !== spec.roomId) {
        net.leave(spec.board)
        current.set(spec.board, spec.roomId)
      }
      net.join(spec, strategiesFor(spec.board))
    }
  }

  const sweep = () => {
    const all = engine.records().filter((r) => !r.hidden)
    if (all.length === 0) return
    sweepBoard = all[sweepIndex++ % all.length]!.id
    reconcile()
  }

  // first background board right away so a fresh invite syncs promptly
  sweep()
  reconcile()
  useApp.subscribe((s, prev) => {
    if (s.route !== prev.route || s.ws !== prev.ws) reconcile()
  })
  engine.events.on('acl-changed', () => reconcile())
  engine.events.on('boards-changed', () => reconcile())
  engine.events.on('local-append', () => reconcile())

  setInterval(sweep, SWEEP_MS)
  setInterval(() => void engine.sync.resyncAll(), 60_000)

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    net.retry(desired(), strategiesFor)
    reconcile()
    void engine.sync.resyncAll()
  })
}
