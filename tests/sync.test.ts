import { describe, expect, it } from 'vitest'
import { randomBytes } from '@noble/hashes/utils.js'
import { uniqueDbName } from './sim'
import { toB64url } from '../src/core/b64'
import { openLawhaDb, type LawhaDb } from '../src/core/db'
import { Engine } from '../src/core/engine'
import { generateIdentity } from '../src/core/identity'
import { createBoardItems, newEntityId, opItem, removeItem, setRoleItem } from '../src/core/actions'
import { toWire } from '../src/core/envelope'
import { LOOK_TTL_MS, type PeerChannel, type SyncAction } from '../src/core/sync'
import type { Role } from '../src/core/types'

/** In-memory transport: async delivery, explicit links, settle() to quiesce. */
class MockNet {
  private inflight = new Set<Promise<unknown>>()
  private links = new Map<string, { a: PeerChannel; b: PeerChannel; ea: Engine; eb: Engine }>()

  link(ea: Engine, eb: Engine, board: string, fps: { a: string; b: string } | null = { a: 'fpA', b: 'fpB' }): string {
    const id = toB64url(randomBytes(6))
    let up = true
    const mk = (from: Engine, to: () => { e: Engine; ch: PeerChannel }, local: string, remote: string): PeerChannel => ({
      key: `${board}:mock:${id}:${from.identity.pub.slice(0, 6)}`,
      board,
      fingerprints: () => (fps ? { local, remote } : null),
      send: (action: SyncAction, payload: unknown) => {
        if (!up) return
        const copy = JSON.parse(JSON.stringify(payload)) as unknown
        const t = to()
        const p = Promise.resolve().then(() => t.e.sync.onMessage(t.ch, action, copy))
        this.track(p)
      },
    })
    const a: PeerChannel = mk(ea, () => ({ e: eb, ch: b }), fps?.a ?? '', fps?.b ?? '')
    const b: PeerChannel = mk(eb, () => ({ e: ea, ch: a }), fps?.b ?? '', fps?.a ?? '')
    this.links.set(id, { a, b, ea, eb })
    ea.sync.onPeerJoin(a)
    eb.sync.onPeerJoin(b)
    const down = () => {
      up = false
      ea.sync.onPeerLeave(a.key)
      eb.sync.onPeerLeave(b.key)
    }
    this.downs.set(id, down)
    return id
  }

  private downs = new Map<string, () => void>()
  channels(id: string): { a: PeerChannel; b: PeerChannel } {
    return this.links.get(id)!
  }
  unlink(id: string): void {
    this.downs.get(id)?.()
  }

  track(p: Promise<unknown>): void {
    this.inflight.add(p)
    void p.finally(() => this.inflight.delete(p))
  }

  async settle(): Promise<void> {
    const engines = new Set([...this.links.values()].flatMap((l) => [l.ea, l.eb]))
    for (let i = 0; i < 200; i++) {
      await Promise.all([...engines].map((e) => e.idle()))
      if (this.inflight.size === 0) {
        await new Promise((r) => setTimeout(r, 5))
        if (this.inflight.size === 0 && [...engines].every((e) => e.idle !== undefined)) {
          await Promise.all([...engines].map((e) => e.idle()))
          if (this.inflight.size === 0) return
        }
      }
      await Promise.allSettled([...this.inflight])
    }
    throw new Error('network did not settle')
  }
}

interface Node {
  e: Engine
  db: LawhaDb
  pub: string
}

async function node(now?: () => number, id = generateIdentity()): Promise<Node> {
  const db = await openLawhaDb(uniqueDbName())
  const e = new Engine(() => db, id, toB64url(randomBytes(16)), { debounceMs: 0, healDelay: { owner: 0, step: 10 }, now })
  return { e, db, pub: id.pub }
}

async function makeBoard(owner: Node, kind: 'board' | 'workspace' = 'board', ws: string | null = null): Promise<string> {
  const nb = createBoardItems(owner.e.identity, { kind, ws, name: kind === 'workspace' ? 'Acme' : 'Board', myName: 'owner', columns: ['Todo'] })
  return owner.e.create(kind, ws, nb)
}

async function grant(owner: Node, board: string, who: Node, role: Exclude<Role, 'owner'>): Promise<void> {
  await owner.e.write([setRoleItem(owner.e.view(board)!, owner.e.identity, who.pub, role)])
}

async function addCard(n: Node, board: string, title: string): Promise<void> {
  const v = n.e.view(board)!
  await n.e.write([
    opItem(v, { k: 'card.create', id: newEntityId(), col: v.columns[0]!.id, pos: 'a' + (v.cards.size + 1), title, desc: '', labels: [], assignees: [], due: null, from: null }),
  ])
}

function titles(n: Node, board: string): string[] {
  const v = n.e.view(board)
  return v ? [...v.cards.values()].map((c) => c.title).sort() : []
}

describe('sync', () => {
  it('an invitee with no data bootstraps the whole board from a member', async () => {
    const net = new MockNet()
    const o = await node()
    const x = await node()
    const b = await makeBoard(o)
    await addCard(o, b, 'hello')
    await grant(o, b, x, 'editor')
    await x.e.follow(b, null)
    net.link(o.e, x.e, b)
    await net.settle()
    const v = x.e.view(b)!
    expect(v.name).toBe('Board')
    expect(v.myRole).toBe('editor')
    expect(titles(x, b)).toEqual(['hello'])
  })

  it('a non-member who knows the board id gets nothing', async () => {
    const net = new MockNet()
    const o = await node()
    const y = await node()
    const b = await makeBoard(o)
    await addCard(o, b, 'private')
    await y.e.follow(b, null)
    net.link(o.e, y.e, b)
    await net.settle()
    expect(y.e.view(b)!.resolved.order).toHaveLength(0)
    expect(o.e.sync.peersOf(b)[0]).toMatchObject({ pub: y.pub, served: false })
  })

  it('relays a member\'s cards while that member is offline', async () => {
    const net = new MockNet()
    const o = await node()
    const a = await node()
    const c = await node()
    const b = await makeBoard(o)
    await grant(o, b, a, 'editor')
    await grant(o, b, c, 'viewer')
    await a.e.follow(b, null)
    await c.e.follow(b, null)
    await addCard(o, b, 'written by o')
    const oa = net.link(o.e, a.e, b)
    await net.settle()
    net.unlink(oa) // o goes offline
    net.link(a.e, c.e, b)
    await net.settle()
    expect(titles(c, b)).toEqual(['written by o'])
  })

  it('pushes new writes live and stops serving a removed member', async () => {
    const net = new MockNet()
    const o = await node()
    const e = await node()
    const b = await makeBoard(o)
    await grant(o, b, e, 'editor')
    await e.e.follow(b, null)
    net.link(o.e, e.e, b)
    await net.settle()
    await addCard(e, b, 'from e')
    await net.settle()
    expect(titles(o, b)).toEqual(['from e'])
    await o.e.write([removeItem(o.e.view(b)!, o.e.identity, e.pub)])
    await net.settle()
    await addCard(o, b, 'after removal')
    await net.settle()
    expect(titles(o, b)).toEqual(['after removal', 'from e'])
    expect(titles(e, b)).toEqual(['from e'])
    expect(e.e.view(b)!.myRole).toBe('none')
  })

  it('a relayed handshake fails: the proof is bound to the connection', async () => {
    const net = new MockNet()
    const p = await node()
    const m = await node()
    const b = await makeBoard(p)
    await grant(p, b, m, 'editor')
    await m.e.follow(b, null)
    // attacker X sits between them and forwards every message verbatim
    let toP: PeerChannel | null = null
    let toM: PeerChannel | null = null
    const xp: PeerChannel = {
      key: `${b}:mock:xp`,
      board: b,
      fingerprints: () => ({ local: 'fpXp', remote: 'fpP' }),
      send: (action, payload) => net.track(Promise.resolve().then(() => m.e.sync.onMessage(toM!, action, payload))),
    }
    const xm: PeerChannel = {
      key: `${b}:mock:xm`,
      board: b,
      fingerprints: () => ({ local: 'fpXm', remote: 'fpM' }),
      send: (action, payload) => net.track(Promise.resolve().then(() => p.e.sync.onMessage(toP!, action, payload))),
    }
    toP = { key: `${b}:mock:p-side`, board: b, fingerprints: () => ({ local: 'fpP', remote: 'fpXp' }), send: (a, pl) => xp.send(a, pl) }
    toM = { key: `${b}:mock:m-side`, board: b, fingerprints: () => ({ local: 'fpM', remote: 'fpXm' }), send: (a, pl) => xm.send(a, pl) }
    p.e.sync.onPeerJoin(toP)
    m.e.sync.onPeerJoin(toM)
    await net.settle()
    expect(p.e.sync.peersOf(b)).toHaveLength(0)
    expect(m.e.sync.peersOf(b)).toHaveLength(0)
  })

  it('parks chains from authors the ACL has not named yet, then promotes them', async () => {
    const net = new MockNet()
    const o = await node()
    const x = await node()
    const late = await node()
    const b = await makeBoard(o)
    await grant(o, b, x, 'editor')
    await x.e.follow(b, null)
    const ox = net.link(o.e, x.e, b)
    await net.settle()
    await addCard(x, b, 'by x')
    await net.settle()
    net.unlink(ox)
    await grant(o, b, late, 'viewer')
    await late.e.follow(b, null)

    // x's chain reaches `late` before any ACL does: parked, not dropped
    const xl = net.link(x.e, late.e, b)
    await net.settle()
    const xMsgs = (await x.db.getAll('messages')).filter((m) => m.author === x.pub).map(toWire)
    net.channels(xl).a.send('msgs', { batch: xMsgs })
    await net.settle()
    expect(await late.db.count('orphans')).toBe(xMsgs.length)
    expect(titles(late, b)).toEqual([])

    // the owner's log names x: the parked chain is promoted
    net.link(o.e, late.e, b)
    await net.settle()
    expect(await late.db.count('orphans')).toBe(0)
    expect(titles(late, b)).toEqual(['by x'])
  })
})

describe('shared boards over one connection', () => {
  it('a connection in one board\'s room carries every other board the two share, live', async () => {
    const net = new MockNet()
    const o = await node()
    const x = await node()
    const b1 = await makeBoard(o)
    const b2 = await makeBoard(o)
    await addCard(o, b2, 'on b2')
    await grant(o, b1, x, 'editor')
    await grant(o, b2, x, 'editor')
    await x.e.follow(b1, null)
    await x.e.follow(b2, null)
    net.link(o.e, x.e, b1)
    await net.settle()
    expect(titles(x, b2)).toEqual(['on b2'])
    await addCard(x, b2, 'from x')
    await net.settle()
    expect(titles(o, b2)).toEqual(['from x', 'on b2'])
    expect(o.e.sync.installs()).toBe(1)
  })

  it('a board offered before the invitee had it is taken up once they follow it', async () => {
    const net = new MockNet()
    const o = await node()
    const x = await node()
    const b1 = await makeBoard(o)
    const b2 = await makeBoard(o)
    await addCard(o, b2, 'later')
    await grant(o, b1, x, 'editor')
    await grant(o, b2, x, 'viewer')
    await x.e.follow(b1, null)
    net.link(o.e, x.e, b1)
    await net.settle()
    expect(x.e.records().map((r) => r.id)).not.toContain(b2)
    await x.e.follow(b2, null) // opens the invite link while still connected
    await net.settle()
    expect(titles(x, b2)).toEqual(['later'])
    expect(x.e.view(b2)!.myRole).toBe('viewer')
  })

  it('offers only boards the ACL names the peer on, so nothing leaks to a non-member', async () => {
    const net = new MockNet()
    const o = await node()
    const y = await node()
    const shared = await makeBoard(o)
    const secret = await makeBoard(o)
    await addCard(o, secret, 'private')
    await grant(o, shared, y, 'editor')
    await y.e.follow(shared, null)
    await y.e.follow(secret, null) // knows the id, is not on it
    net.link(o.e, y.e, shared)
    await net.settle()
    expect(y.e.view(secret)!.resolved.order).toHaveLength(0)
    expect(o.e.sync.peersOf(secret)).toHaveLength(0)
  })

  it('when the carrying connection goes, another one to the same install takes over', async () => {
    const net = new MockNet()
    const o = await node()
    const x = await node()
    const [b1, b2, b3] = [await makeBoard(o), await makeBoard(o), await makeBoard(o)]
    for (const b of [b1, b2, b3]) {
      await grant(o, b, x, 'editor')
      await x.e.follow(b, null)
    }
    const first = net.link(o.e, x.e, b1)
    await net.settle()
    net.link(o.e, x.e, b3)
    await net.settle()
    net.unlink(first)
    await net.settle()
    await addCard(o, b2, 'still flows')
    await addCard(o, b1, 'b1 too')
    await net.settle()
    expect(titles(x, b2)).toEqual(['still flows'])
    expect(titles(x, b1)).toEqual(['b1 too'])
  })
})

describe('company workspaces', () => {
  it('a company board room exists only for roster members, and outsiders cannot connect', async () => {
    const net = new MockNet()
    const o = await node()
    const a = await node()
    const outsider = await node()
    const ws = await makeBoard(o, 'workspace')
    await grant(o, ws, a, 'editor')
    const b = await makeBoard(o, 'board', ws)
    await grant(o, b, a, 'editor')
    await grant(o, b, outsider, 'editor') // on the board, but not in the company
    await a.e.follow(ws, ws)
    await a.e.follow(b, ws)
    await outsider.e.follow(b, ws)

    // a learns the roster (and the network key) in the workspace's own room
    expect(a.e.roomSpec(b)).toBeNull()
    net.link(o.e, a.e, ws)
    await net.settle()
    expect(a.e.roomSpec(b)).toEqual(o.e.roomSpec(b))
    expect(outsider.e.roomSpec(b)).toBeNull()

    net.link(o.e, a.e, b)
    net.link(o.e, outsider.e, b)
    await net.settle()
    expect(a.e.view(b)!.name).toBe('Board')
    expect(outsider.e.view(b)!.resolved.order).toHaveLength(0)
    // a reaches b both in its room and over the workspace connection; the outsider in neither
    expect([...new Set(o.e.sync.peersOf(b).map((p) => p.pub))]).toEqual([a.pub])
  })

  it('coworkers who meet in the workspace room sync the company boards they share', async () => {
    const net = new MockNet()
    const o = await node()
    const a = await node()
    const outsider = await node()
    const ws = await makeBoard(o, 'workspace')
    await grant(o, ws, a, 'editor')
    const b = await makeBoard(o, 'board', ws)
    await addCard(o, b, 'company card')
    await grant(o, b, a, 'editor')
    await grant(o, b, outsider, 'editor') // on the board, but not in the company
    await a.e.follow(ws, ws)
    await a.e.follow(b, ws)
    await outsider.e.follow(b, ws)
    const personal = await makeBoard(o)
    await grant(o, personal, outsider, 'editor')
    await outsider.e.follow(personal, null)

    net.link(o.e, a.e, ws) // nobody opened the board
    net.link(o.e, outsider.e, personal)
    await net.settle()
    expect(titles(a, b)).toEqual(['company card'])
    // the outsider shares a personal board with o, but company boards stay behind the roster
    expect(outsider.e.view(b)!.resolved.order).toHaveLength(0)
  })

  it('removing a coworker rotates the company network secret', async () => {
    const net = new MockNet()
    const o = await node()
    const a = await node()
    const ws = await makeBoard(o, 'workspace')
    await grant(o, ws, a, 'editor')
    const b = await makeBoard(o, 'board', ws)
    await a.e.follow(ws, ws)
    net.link(o.e, a.e, ws)
    await net.settle()
    const before = a.e.roomSpec(b)
    expect(before).not.toBeNull()
    await o.e.write([removeItem(o.e.view(ws)!, o.e.identity, a.pub)])
    await net.settle()
    expect(o.e.roomSpec(b)).not.toEqual(before)
    expect(a.e.roomSpec(b)).toEqual(before) // a is stuck on the old, abandoned rooms
  })
})


/**
 * A link that records what each side is sent (`mux` as `mux:<action>`), and
 * can make `b` an install from before `look`: its `hi` lacks the flag.
 */
function tapLink(net: MockNet, ea: Engine, eb: Engine, board: string, bIsOld = false): { toA: string[]; toB: string[] } {
  const seen = { toA: [] as string[], toB: [] as string[] }
  const name = (action: SyncAction, payload: unknown) =>
    action === 'mux' ? `mux:${(payload as { a: string }).a}` : action
  const a: PeerChannel = {
    key: `${board}:tap:a`,
    board,
    fingerprints: () => ({ local: 'fpA', remote: 'fpB' }),
    send: (action, payload) => {
      seen.toB.push(name(action, payload))
      const copy = JSON.parse(JSON.stringify(payload)) as unknown
      net.track(Promise.resolve().then(() => eb.sync.onMessage(b, action, copy)))
    },
  }
  const b: PeerChannel = {
    key: `${board}:tap:b`,
    board,
    fingerprints: () => ({ local: 'fpB', remote: 'fpA' }),
    send: (action, payload) => {
      seen.toA.push(name(action, payload))
      const copy = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
      const auth = action === 'auth' ? copy : action === 'mux' && copy.a === 'auth' ? (copy.p as Record<string, unknown>) : null
      if (bIsOld && auth?.step === 'hi') delete auth.look
      net.track(Promise.resolve().then(() => ea.sync.onMessage(a, action, copy)))
    },
  }
  ea.sync.onPeerJoin(a)
  eb.sync.onPeerJoin(b)
  return seen
}

async function settleAll(net: MockNet, ...nodes: Node[]): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await net.settle()
    await Promise.all(nodes.map((n) => n.e.idle()))
  }
}

describe('who has a card open', () => {
  async function shared(now?: () => number): Promise<{ net: MockNet; o: Node; x: Node; b: string; card: string }> {
    const net = new MockNet()
    const o = await node(now)
    const x = await node(now)
    const b = await makeBoard(o)
    await addCard(o, b, 'c')
    await grant(o, b, x, 'editor')
    await x.e.follow(b, null)
    return { net, o, x, b, card: [...o.e.view(b)!.cards.keys()][0]! }
  }

  it('members see which card the other has open, until it is closed', async () => {
    const { net, o, x, b, card } = await shared()
    net.link(o.e, x.e, b)
    await net.settle()
    x.e.sync.look({ board: b, card })
    await net.settle()
    expect(o.e.sync.lookers(b)).toEqual({ [card]: [x.pub] })
    expect(x.e.sync.lookers(b)).toEqual({}) // not ourselves
    x.e.sync.look(null)
    await net.settle()
    expect(o.e.sync.lookers(b)).toEqual({})
  })

  it('a member who connects later is told what is already open', async () => {
    const { net, o, x, b, card } = await shared()
    o.e.sync.look({ board: b, card })
    net.link(o.e, x.e, b)
    await net.settle()
    expect(x.e.sync.lookers(b)).toEqual({ [card]: [o.pub] })
  })

  it('a look lapses without a repeat, and when the connection goes', async () => {
    let t = Date.now()
    const { net, o, x, b, card } = await shared(() => t)
    const id = net.link(o.e, x.e, b)
    await net.settle()
    x.e.sync.look({ board: b, card })
    await net.settle()
    t += LOOK_TTL_MS + 1
    expect(o.e.sync.lookers(b)).toEqual({})
    x.e.sync.look({ board: b, card }) // the repeat
    await net.settle()
    expect(o.e.sync.lookers(b)).toEqual({ [card]: [x.pub] })
    const told: string[] = []
    o.e.events.on('looks', ({ board }) => told.push(board))
    net.unlink(id)
    expect(o.e.sync.lookers(b)).toEqual({})
    expect(told).toEqual([b])
  })

  it('a non-member is neither told nor heard', async () => {
    const net = new MockNet()
    const o = await node()
    const y = await node()
    const b = await makeBoard(o)
    await addCard(o, b, 'c')
    const card = [...o.e.view(b)!.cards.keys()][0]!
    await y.e.follow(b, null) // knows the id, is not on it
    const seen = tapLink(net, o.e, y.e, b)
    await settleAll(net, o, y)
    o.e.sync.look({ board: b, card })
    y.e.sync.look({ board: b, card })
    await settleAll(net, o, y)
    expect(seen.toB).not.toContain('look')
    expect(o.e.sync.lookers(b)).toEqual({})
  })

  it('a removed member drops out at once and is told nothing more', async () => {
    const { net, o, x, b, card } = await shared()
    net.link(o.e, x.e, b)
    await net.settle()
    x.e.sync.look({ board: b, card })
    await net.settle()
    expect(o.e.sync.lookers(b)).toEqual({ [card]: [x.pub] })
    await o.e.write([removeItem(o.e.view(b)!, o.e.identity, x.pub)])
    await net.settle()
    expect(o.e.sync.lookers(b)).toEqual({})
  })

  it('an install from before `look` is never sent one, directly or carried', async () => {
    const o = await node()
    const x = await node()
    const [b1, b2] = [await makeBoard(o), await makeBoard(o)]
    for (const b of [b1, b2]) {
      await addCard(o, b, 'c')
      await grant(o, b, x, 'editor')
      await x.e.follow(b, null)
    }
    const net = new MockNet()
    const seen = tapLink(net, o.e, x.e, b1, true)
    await settleAll(net, o, x)
    expect(seen.toB).toContain('mux:have') // b2 is carried over the same connection
    for (const b of [b1, b2]) o.e.sync.look({ board: b, card: [...o.e.view(b)!.cards.keys()][0]! })
    o.e.sync.look(null)
    await settleAll(net, o, x)
    expect(seen.toB.filter((a) => a.endsWith('look'))).toEqual([])
  })

  it('my other devices are not someone else', async () => {
    const net = new MockNet()
    const o = await node()
    const o2 = await node(undefined, o.e.identity) // the same key on another device
    const b = await makeBoard(o)
    await addCard(o, b, 'c')
    const card = [...o.e.view(b)!.cards.keys()][0]!
    await o2.e.follow(b, null)
    net.link(o.e, o2.e, b)
    await net.settle()
    o2.e.sync.look({ board: b, card })
    await net.settle()
    expect(o.e.sync.lookers(b)).toEqual({})
  })
})
