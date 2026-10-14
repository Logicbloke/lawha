import { describe, expect, it } from 'vitest'
import { NetworkManager, type JoinFn, type TrysteroRoom } from '../src/core/net'
import type { RoomSpec } from '../src/core/engine'

interface FakeRoom extends TrysteroRoom {
  dead: boolean
  config: Record<string, unknown>
}

/** Trystero's room bookkeeping as it behaves: asking for an occupied room id returns that room, even one still leaving. */
function fakeTrystero() {
  const occupied = new Map<string, FakeRoom>()
  const created: FakeRoom[] = []
  /** rooms still leaving when each new room was created */
  const leavingAtJoin: number[] = []
  let leavingNow = 0
  const join: JoinFn = (config, roomId) => {
    const existing = occupied.get(roomId)
    if (existing) return existing
    leavingAtJoin.push(leavingNow)
    const room: FakeRoom = {
      dead: false,
      config,
      makeAction: () => ({ send: async () => undefined, onMessage: null }),
      getPeers: () => ({}),
      onPeerJoin: null,
      onPeerLeave: null,
      leave: async () => {
        leavingNow++
        await new Promise((r) => setTimeout(r, roomId === 'room-2' ? 45 : 20))
        room.dead = true
        occupied.delete(roomId)
        leavingNow--
      },
    }
    occupied.set(roomId, room)
    created.push(room)
    return room
  }
  return { join, occupied, created, leavingAtJoin }
}

const spec: RoomSpec = { board: 'b1', roomId: 'room-1', password: 'pw' }
const quiet = { onPeer: () => undefined, onPeerGone: () => undefined, onMessage: () => undefined }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('network rooms', () => {
  it('a room left and wanted again at once is joined afresh once the leave is done, not reused while dying', async () => {
    const t = fakeTrystero()
    const net = new NetworkManager(quiet, { strategies: ['mqtt'], joins: { mqtt: t.join } })
    net.join(spec, ['mqtt'])
    net.leave(spec.board)
    net.join(spec, ['mqtt']) // e.g. back on the board within a moment
    await wait(60)
    expect(t.created).toHaveLength(2)
    expect(t.created[0]!.dead).toBe(true)
    expect(t.occupied.get('room-1')).toBe(t.created[1])
    expect(t.created[1]!.dead).toBe(false)
    expect(net.strategiesOf(spec.board)).toEqual(['mqtt'])
  })

  it('a board no longer wanted by the time its old room has left is not joined again', async () => {
    const t = fakeTrystero()
    const net = new NetworkManager(quiet, { strategies: ['mqtt'], joins: { mqtt: t.join } })
    net.join(spec, ['mqtt'])
    net.leave(spec.board)
    net.join(spec, ['mqtt'])
    net.leave(spec.board)
    await wait(60)
    expect(t.created).toHaveLength(1)
    expect(net.joinedBoards()).toEqual([])
  })

  it('restart rejoins every room only after all have left, with the new ICE servers', async () => {
    const t = fakeTrystero()
    let ice: RTCIceServer[] = []
    const net = new NetworkManager(quiet, { strategies: ['mqtt'], joins: { mqtt: t.join }, iceServers: () => ice })
    net.join(spec, ['mqtt'])
    net.join({ board: 'b2', roomId: 'room-2', password: 'pw' }, ['mqtt'])
    expect(t.created[0]!.config.turnConfig).toBeUndefined()
    ice = [{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' }]
    net.restart()
    net.join(spec, ['mqtt']) // a reconcile in the meantime waits too
    await wait(90)
    expect(t.created).toHaveLength(4)
    // Trystero would build the new connections from a room still leaving
    expect(t.leavingAtJoin).toEqual([0, 0, 0, 0])
    expect(t.created.slice(0, 2).every((r) => r.dead)).toBe(true)
    expect(t.created.slice(2).map((r) => r.config.turnConfig)).toEqual([ice, ice])
    expect(net.joinedBoards().sort()).toEqual(['b1', 'b2'])
  })

  it('reports how many relay sockets are open per strategy in use', () => {
    const t = fakeTrystero()
    const seen: unknown[] = []
    const net = new NetworkManager(quiet, {
      strategies: ['mqtt'],
      joins: { mqtt: t.join },
      sockets: { mqtt: () => ({ a: { readyState: 1 }, b: { readyState: 0 }, c: { readyState: 3 } }) },
    })
    net.events.on('relays', (r) => seen.push(r))
    net.join(spec, ['mqtt'])
    net.checkRelays() // unchanged: no second report
    expect(seen).toEqual([{ mqtt: { open: 1, total: 3 } }])
  })
})
