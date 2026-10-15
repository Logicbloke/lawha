import { joinRoom as joinNostr, getRelaySockets as nostrSockets } from '@trystero-p2p/nostr'
import { joinRoom as joinMqtt, getRelaySockets as mqttSockets } from '@trystero-p2p/mqtt'
import { joinRoom as joinTorrent, getRelaySockets as torrentSockets } from '@trystero-p2p/torrent'
import { Emitter } from './events'
import { PIECE_ACTION, SYNC_ACTIONS, type PeerChannel, type SyncAction } from './sync'
import type { RoomSpec } from './engine'

export const APP_ID = 'lawha-v1'
export const ALL_STRATEGIES = ['nostr', 'mqtt', 'torrent'] as const
export type Strategy = (typeof ALL_STRATEGIES)[number]

/**
 * Nostr relays that forward the ephemeral events Trystero signals with
 * (checked 2026-10). Trystero's own pick for this app id had three of five
 * dead or refusing; nos.lol stays so older installs still meet us. Not
 * relay.damus.io: it takes a few notes a minute per IP and then bans the IP
 * for an hour, and every room announces on each relay every 5.3 s.
 */
export const NOSTR_RELAYS = ['wss://relay2.angor.io', 'wss://relay02.lnfi.network', 'wss://nos.lol', 'wss://purplerelay.com']

/** WebTorrent trackers that answer (checked 2026-10): two of Trystero's three picks are gone. */
export const TORRENT_TRACKERS = ['wss://tracker.webtorrent.dev', 'wss://tracker.openwebtorrent.com']

export interface NetHandlers {
  onPeer(ch: PeerChannel): void
  onPeerGone(key: string): void
  onMessage(ch: PeerChannel, action: SyncAction, payload: unknown): void
  /** an attachment piece: raw bytes and their metadata */
  onPiece?(ch: PeerChannel, data: unknown, meta: unknown): void
}

/** How many of a discovery network's relays we hold an open socket to. */
export interface RelayHealth {
  open: number
  total: number
}

export interface NetEvents {
  /** per discovery network in use */
  relays: Record<string, RelayHealth>
  /** found a peer through a relay, but no direct connection could be made */
  unreachable: { strategy: string }
}

export interface NetOptions {
  /** limit to a subset of strategies (testing / env override) */
  strategies?: string[]
  /** point the mqtt strategy at a local broker for deterministic testing */
  mqttUrls?: string[]
  /** ICE servers to add to Trystero's STUN defaults (a TURN relay), read per join */
  iceServers?: () => RTCIceServer[]
  /** stand-ins for the Trystero strategies (unit tests) */
  joins?: Partial<Record<Strategy, JoinFn>>
  /** current relay sockets per strategy (unit tests) */
  sockets?: Partial<Record<Strategy, () => Record<string, { readyState: number }>>>
}

interface MessageAction {
  send(data: unknown, options?: { target?: string; metadata?: unknown }): Promise<void>
  onMessage: ((data: unknown, context: { peerId: string; metadata?: unknown }) => void) | null
}

export interface TrysteroRoom {
  makeAction(namespace: string): MessageAction
  getPeers(): Record<string, RTCPeerConnection>
  onPeerJoin: ((peerId: string) => void) | null
  onPeerLeave: ((peerId: string) => void) | null
  leave(): Promise<void>
}

export type JoinFn = (
  config: { appId: string } & Record<string, unknown>,
  roomId: string,
  callbacks?: { onJoinError?: (details: { error?: string }) => void },
) => TrysteroRoom

const JOINS: Record<Strategy, JoinFn> = {
  nostr: joinNostr as unknown as JoinFn,
  mqtt: joinMqtt as unknown as JoinFn,
  torrent: joinTorrent as unknown as JoinFn,
}

const SOCKETS: Record<Strategy, () => Record<string, { readyState: number } | undefined>> = {
  nostr: nostrSockets as () => Record<string, WebSocket>,
  mqtt: mqttSockets as () => Record<string, WebSocket | undefined>,
  torrent: torrentSockets as () => Record<string, WebSocket>,
}

/** All `a=fingerprint:` values of an SDP, in order — what DTLS will prove. */
export function sdpFingerprints(sdp: string | undefined | null): string {
  if (!sdp) return ''
  return [...sdp.matchAll(/^a=fingerprint:(\S+) (\S+)\s*$/gim)].map((m) => `${m[1]!.toLowerCase()} ${m[2]!.toUpperCase()}`).join(',')
}

interface Joined {
  strategy: Strategy
  roomId: string
  room: TrysteroRoom
  peers: Set<string>
}

/**
 * One Trystero room per board per discovery strategy. Rooms are named by
 * values derived from the board id (or, for company boards, from the
 * company's network secret), so only people who know them can find each
 * other. Every strategy failing is non-fatal by design.
 */
export class NetworkManager {
  readonly events = new Emitter<NetEvents>()
  private rooms = new Map<string, Joined[]>()
  private channels = new Map<string, PeerChannel>()
  /** what each board should be joined as; a join waiting on a leave reads it */
  private wanted = new Map<string, { spec: RoomSpec; strategies: readonly Strategy[] }>()
  /** `${strategy}:${roomId}` → its leave in flight */
  private leaving = new Map<string, Promise<void>>()
  /** a restart waiting for every room to finish leaving */
  private restarting: Promise<void> | null = null
  private health = ''

  constructor(
    private handlers: NetHandlers,
    private options: NetOptions = {},
  ) {}

  joinedBoards(): string[] {
    return [...this.rooms.keys()]
  }

  strategiesOf(board: string): string[] {
    return (this.rooms.get(board) ?? []).map((j) => j.strategy)
  }

  /** Join (or re-join with different strategies) the room for a board. */
  join(spec: RoomSpec, strategies: readonly Strategy[]): void {
    const allowed = strategies.filter((s) => !this.options.strategies || this.options.strategies.includes(s))
    this.wanted.set(spec.board, { spec, strategies })
    if (this.restarting) return
    for (const j of this.rooms.get(spec.board) ?? []) {
      if (!allowed.includes(j.strategy) || j.roomId !== spec.roomId) this.leaveOne(spec.board, j)
    }
    const kept = (this.rooms.get(spec.board) ?? []).filter((j) => allowed.includes(j.strategy) && j.roomId === spec.roomId)
    for (const s of allowed) {
      if (kept.some((j) => j.strategy === s)) continue
      // Trystero hands back a room that is still leaving (and dies a moment
      // later) if asked for it again too soon: join once the leave is done
      const pending = this.leaving.get(`${s}:${spec.roomId}`)
      if (pending) {
        void pending.then(() => this.rejoin(spec.board))
        continue
      }
      const j = this.joinOne(spec, s)
      if (j) kept.push(j)
    }
    this.rooms.set(spec.board, kept)
    this.checkRelays()
  }

  leave(board: string): void {
    this.wanted.delete(board)
    for (const j of this.rooms.get(board) ?? []) this.leaveOne(board, j)
    this.rooms.delete(board)
    this.checkRelays()
  }

  stop(): void {
    for (const board of [...this.rooms.keys()]) this.leave(board)
  }

  /**
   * Leave every room, then join them all again: Trystero takes connection
   * settings (ICE servers) from the first room joined per strategy, so every
   * room must be gone before the new settings can apply.
   */
  restart(): void {
    for (const [board, list] of [...this.rooms]) for (const j of list) this.leaveOne(board, j)
    this.rooms.clear()
    const done = Promise.all([...this.leaving.values()]).then(() => undefined)
    this.restarting = done
    void done.then(() => {
      if (this.restarting !== done) return
      this.restarting = null
      for (const w of [...this.wanted.values()]) this.join(w.spec, w.strategies)
    })
  }

  /** Relay sockets per strategy in use: reported when the picture changes. */
  checkRelays(): void {
    const used = new Set([...this.rooms.values()].flat().map((j) => j.strategy))
    const health: Record<string, RelayHealth> = {}
    for (const s of ALL_STRATEGIES) {
      if (!used.has(s)) continue
      let sockets: Record<string, { readyState: number } | undefined> = {}
      try {
        sockets = (this.options.sockets?.[s] ?? SOCKETS[s])()
      } catch {
        // not initialised yet
      }
      const list = Object.values(sockets)
      health[s] = { open: list.filter((w) => w?.readyState === 1).length, total: list.length }
    }
    const key = JSON.stringify(health)
    if (key === this.health) return
    this.health = key
    this.events.emit('relays', health)
  }

  private rejoin(board: string): void {
    const w = this.wanted.get(board)
    if (w) this.join(w.spec, w.strategies)
  }

  private leaveOne(board: string, j: Joined): void {
    for (const peerId of j.peers) {
      const key = `${board}:${j.strategy}:${peerId}`
      this.channels.delete(key)
      this.handlers.onPeerGone(key)
    }
    j.peers.clear()
    j.room.onPeerJoin = null
    j.room.onPeerLeave = null
    const k = `${j.strategy}:${j.roomId}`
    const done: Promise<void> = j.room
      .leave()
      .catch(() => undefined)
      .then(() => {
        if (this.leaving.get(k) === done) this.leaving.delete(k)
      })
    this.leaving.set(k, done)
    this.rooms.set(
      board,
      (this.rooms.get(board) ?? []).filter((x) => x !== j),
    )
  }

  private joinOne(spec: RoomSpec, strategy: Strategy): Joined | null {
    const config: Record<string, unknown> = { password: spec.password }
    if (strategy === 'mqtt' && this.options.mqttUrls) config.relayConfig = { urls: this.options.mqttUrls }
    if (strategy === 'nostr') config.relayConfig = { urls: NOSTR_RELAYS }
    if (strategy === 'torrent') config.relayConfig = { urls: TORRENT_TRACKERS }
    const ice = this.options.iceServers?.() ?? []
    if (ice.length > 0) config.turnConfig = ice
    let room: TrysteroRoom
    try {
      room = (this.options.joins?.[strategy] ?? JOINS[strategy])({ appId: APP_ID, ...config }, spec.roomId, {
        // Trystero reports per-peer trouble here, not a failed join. The one
        // worth surfacing: signalling worked, the direct connection did not
        onJoinError: (details) => {
          if (/could not connect to peer/i.test(details?.error ?? '')) this.events.emit('unreachable', { strategy })
        },
      })
    } catch {
      return null
    }
    const joined: Joined = { strategy, roomId: spec.roomId, room, peers: new Set() }
    const keyOf = (peerId: string) => `${spec.board}:${strategy}:${peerId}`
    const senders = new Map<SyncAction, MessageAction>()

    for (const action of SYNC_ACTIONS) {
      const ma = room.makeAction(action)
      senders.set(action, ma)
      ma.onMessage = (data, ctx) => {
        const ch = this.channels.get(keyOf(ctx.peerId))
        if (ch) this.handlers.onMessage(ch, action, data)
      }
    }
    const pieces = room.makeAction(PIECE_ACTION)
    pieces.onMessage = (data, ctx) => {
      const ch = this.channels.get(keyOf(ctx.peerId))
      if (ch) this.handlers.onPiece?.(ch, data, ctx.metadata)
    }

    room.onPeerJoin = (peerId) => {
      const key = keyOf(peerId)
      const ch: PeerChannel = {
        key,
        board: spec.board,
        send: (action, payload) =>
          void senders.get(action)!.send(payload, { target: peerId }).catch(() => undefined),
        sendBin: (data, meta) => pieces.send(data, { target: peerId, metadata: meta }).catch(() => undefined),
        fingerprints: () => {
          try {
            const pc = room.getPeers()[peerId]
            if (!pc) return null
            return {
              local: sdpFingerprints(pc.localDescription?.sdp),
              remote: sdpFingerprints(pc.remoteDescription?.sdp),
            }
          } catch {
            return null
          }
        },
      }
      this.channels.set(key, ch)
      joined.peers.add(peerId)
      this.handlers.onPeer(ch)
    }

    room.onPeerLeave = (peerId) => {
      const key = keyOf(peerId)
      this.channels.delete(key)
      joined.peers.delete(peerId)
      this.handlers.onPeerGone(key)
    }

    return joined
  }
}
