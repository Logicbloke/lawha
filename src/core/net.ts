import { joinRoom as joinNostr } from '@trystero-p2p/nostr'
import { joinRoom as joinMqtt } from '@trystero-p2p/mqtt'
import { joinRoom as joinTorrent } from '@trystero-p2p/torrent'
import { Emitter, type StrategyState } from './events'
import { SYNC_ACTIONS, type PeerChannel, type SyncAction } from './sync'
import type { RoomSpec } from './engine'

export const APP_ID = 'lawha-v1'
export const ALL_STRATEGIES = ['nostr', 'mqtt', 'torrent'] as const
export type Strategy = (typeof ALL_STRATEGIES)[number]

export interface NetHandlers {
  onPeer(ch: PeerChannel): void
  onPeerGone(key: string): void
  onMessage(ch: PeerChannel, action: SyncAction, payload: unknown): void
}

export interface NetEvents {
  'peer-status': { strategy: string; state: StrategyState; peerCount: number }
}

export interface NetOptions {
  /** limit to a subset of strategies (testing / env override) */
  strategies?: string[]
  /** point the mqtt strategy at a local broker for deterministic testing */
  mqttUrls?: string[]
}

interface MessageAction {
  send(data: unknown, options?: { target?: string }): Promise<void>
  onMessage: ((data: unknown, context: { peerId: string }) => void) | null
}

interface TrysteroRoom {
  makeAction(namespace: string): MessageAction
  getPeers(): Record<string, RTCPeerConnection>
  onPeerJoin: ((peerId: string) => void) | null
  onPeerLeave: ((peerId: string) => void) | null
  leave(): Promise<void>
}

type JoinFn = (
  config: { appId: string } & Record<string, unknown>,
  roomId: string,
  callbacks?: { onJoinError?: (details: unknown) => void },
) => TrysteroRoom

const JOINS: Record<Strategy, JoinFn> = {
  nostr: joinNostr as unknown as JoinFn,
  mqtt: joinMqtt as unknown as JoinFn,
  torrent: joinTorrent as unknown as JoinFn,
}

/** All `a=fingerprint:` values of an SDP, in order — what DTLS will prove. */
export function sdpFingerprints(sdp: string | undefined | null): string {
  if (!sdp) return ''
  return [...sdp.matchAll(/^a=fingerprint:(\S+) (\S+)\s*$/gim)].map((m) => `${m[1]!.toLowerCase()} ${m[2]!.toUpperCase()}`).join(',')
}

interface Joined {
  strategy: Strategy
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
  private failed = new Set<string>()

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
    const existing = this.rooms.get(spec.board) ?? []
    for (const j of existing) {
      if (!allowed.includes(j.strategy)) this.leaveOne(spec.board, j)
    }
    const kept = (this.rooms.get(spec.board) ?? []).filter((j) => allowed.includes(j.strategy))
    for (const s of allowed) {
      if (kept.some((j) => j.strategy === s)) continue
      const j = this.joinOne(spec, s)
      if (j) kept.push(j)
    }
    this.rooms.set(spec.board, kept)
  }

  leave(board: string): void {
    for (const j of this.rooms.get(board) ?? []) this.leaveOne(board, j)
    this.rooms.delete(board)
  }

  stop(): void {
    for (const board of [...this.rooms.keys()]) this.leave(board)
  }

  /** Re-join strategies that failed (e.g. after the tab was backgrounded on iOS). */
  retry(specs: RoomSpec[], strategiesFor: (board: string) => readonly Strategy[]): void {
    if (this.failed.size === 0) return
    this.failed.clear()
    for (const spec of specs) {
      this.leave(spec.board)
      this.join(spec, strategiesFor(spec.board))
    }
  }

  private peerCount(strategy: string): number {
    let n = 0
    for (const list of this.rooms.values()) for (const j of list) if (j.strategy === strategy) n += j.peers.size
    return n
  }

  private status(strategy: string, state: StrategyState): void {
    this.events.emit('peer-status', { strategy, state, peerCount: this.peerCount(strategy) })
  }

  private leaveOne(board: string, j: Joined): void {
    for (const peerId of j.peers) {
      const key = `${board}:${j.strategy}:${peerId}`
      this.channels.delete(key)
      this.handlers.onPeerGone(key)
    }
    j.peers.clear()
    void j.room.leave().catch(() => undefined)
    this.status(j.strategy, 'connected')
  }

  private joinOne(spec: RoomSpec, strategy: Strategy): Joined | null {
    const config: Record<string, unknown> = { password: spec.password }
    if (strategy === 'mqtt' && this.options.mqttUrls) config.relayConfig = { urls: this.options.mqttUrls }
    let room: TrysteroRoom
    try {
      room = JOINS[strategy]({ appId: APP_ID, ...config }, spec.roomId, {
        onJoinError: () => {
          this.failed.add(`${spec.board}:${strategy}`)
          this.status(strategy, 'failed')
        },
      })
    } catch {
      this.failed.add(`${spec.board}:${strategy}`)
      this.status(strategy, 'failed')
      return null
    }
    const joined: Joined = { strategy, room, peers: new Set() }
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

    room.onPeerJoin = (peerId) => {
      const key = keyOf(peerId)
      const ch: PeerChannel = {
        key,
        board: spec.board,
        send: (action, payload) =>
          void senders.get(action)!.send(payload, { target: peerId }).catch(() => undefined),
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
      this.status(strategy, 'connected')
      this.handlers.onPeer(ch)
    }

    room.onPeerLeave = (peerId) => {
      const key = keyOf(peerId)
      this.channels.delete(key)
      joined.peers.delete(peerId)
      this.status(strategy, 'connected')
      this.handlers.onPeerGone(key)
    }

    this.status(strategy, 'connecting')
    return joined
  }
}
