import { describe, expect, it, vi } from 'vitest'
import { randomBytes } from '@noble/hashes/utils.js'
import { uniqueDbName } from './sim'
import { fromB64url, toB64url } from '../src/core/b64'
import { openLawhaDb, type LawhaDb } from '../src/core/db'
import { DEFAULT_EAGER_BYTES, Engine } from '../src/core/engine'
import { generateIdentity } from '../src/core/identity'
import { attachOp, createBoardItems, newEntityId, opItem, removeItem, setRoleItem } from '../src/core/actions'
import { PIECE_SIZE, openPiece, sealFile } from '../src/core/blobcrypto'
import type { Attachment } from '../src/core/board'
import { toWire } from '../src/core/envelope'
import { LOOK_TTL_MS, type PeerChannel, type PieceMeta, type SyncAction } from '../src/core/sync'
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
      sendBin: async (data: Uint8Array, meta: PieceMeta) => {
        if (!up) return
        const copy = data.slice()
        const m = JSON.parse(JSON.stringify(meta)) as unknown
        const t = to()
        this.track(Promise.resolve().then(() => t.e.sync.onPiece(t.ch, copy, m)))
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

async function node(now?: () => number, id = generateIdentity(), dev = toB64url(randomBytes(16))): Promise<Node> {
  const db = await openLawhaDb(uniqueDbName())
  const e = new Engine(() => db, id, dev, { debounceMs: 0, healDelay: { owner: 0, step: 10 }, now })
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

describe('my other installs', () => {
  it('one that has only imported the key meets the others in their private room and, once allowed, takes up every board', async () => {
    const net = new MockNet()
    const o = await node()
    const ws = await makeBoard(o, 'workspace')
    const cb = await makeBoard(o, 'board', ws)
    const pb = await makeBoard(o)
    await addCard(o, cb, 'company card')
    await addCard(o, pb, 'personal card')
    const phone = await node(undefined, o.e.identity)
    expect(phone.e.self).toEqual(o.e.self)
    expect(phone.e.records()).toHaveLength(0)
    const asked: string[] = []
    o.e.events.on('device-waiting', ({ dev }) => asked.push(dev))
    const adopted: string[] = []
    phone.e.events.on('adopted', ({ board }) => adopted.push(board))

    net.link(o.e, phone.e, o.e.self.board)
    await net.settle()
    // the key alone gets nothing until the person allows the device on the laptop
    expect(phone.e.records()).toHaveLength(0)
    expect(asked).toContain(phone.e.dev)
    expect(o.e.sync.waitingDevices()).toEqual([phone.e.dev])

    o.e.approvedDevice = (dev) => dev === phone.e.dev
    o.e.sync.reoffer()
    await net.settle()
    expect(o.e.sync.waitingDevices()).toEqual([])
    expect(adopted.sort()).toEqual([ws, cb, pb].sort())
    // filled from the laptop, the phone has nothing to ask about it
    expect(phone.e.sync.waitingDevices()).toEqual([])
    expect(titles(phone, cb)).toEqual(['company card'])
    expect(titles(phone, pb)).toEqual(['personal card'])
    expect(phone.e.view(cb)!.myRole).toBe('owner')
    // what each is and where it belongs, as on the device it came from
    const kinds = (n: Node) => Object.fromEntries(n.e.records().map((r) => [r.id, [r.kind, n.e.wsOf(r.id)]]))
    expect(kinds(phone)).toEqual(kinds(o))
    expect(kinds(phone)[ws]![0]).toBe('workspace')
    expect(phone.e.roomSpec(cb)).toEqual(o.e.roomSpec(cb))
    expect(o.e.sync.installs()).toBe(1)

    await addCard(phone, pb, 'from the phone')
    await net.settle()
    expect(titles(o, pb)).toEqual(['from the phone', 'personal card'])
  })

  it('no other key gets into the private room, nor anything out of it', async () => {
    const net = new MockNet()
    const o = await node()
    await addCard(o, await makeBoard(o), 'mine')
    const x = await node()
    net.link(o.e, x.e, o.e.self.board) // as if the room id and password had leaked
    await net.settle()
    expect(o.e.sync.installs()).toBe(0)
    expect(x.e.records()).toHaveLength(0)
  })

  it('a coworker\'s offer adds no board: only our own key\'s does', async () => {
    const net = new MockNet()
    const o = await node()
    const x = await node()
    const b1 = await makeBoard(o)
    const b2 = await makeBoard(o)
    await grant(o, b1, x, 'editor')
    await grant(o, b2, x, 'editor')
    await x.e.follow(b1, null)
    const adopt = vi.fn()
    x.e.events.on('adopted', adopt)
    net.link(o.e, x.e, b1)
    await net.settle()
    expect(x.e.records().map((r) => r.id)).toEqual([b1])
    expect(adopt).not.toHaveBeenCalled()
  })

  it('until allowed, it gets only the boards it names itself', async () => {
    const net = new MockNet()
    const o = await node()
    const b1 = await makeBoard(o)
    await makeBoard(o) // only on the laptop
    await addCard(o, b1, 'on b1')
    const phone = await node(undefined, o.e.identity)
    await phone.e.follow(b1, null) // opened its link
    net.link(o.e, phone.e, b1)
    net.link(o.e, phone.e, o.e.self.board)
    await net.settle()
    expect(titles(phone, b1)).toEqual(['on b1'])
    expect(phone.e.records().map((r) => r.id)).toEqual([b1])
    expect(o.e.sync.waitingDevices()).toEqual([phone.e.dev])
  })

  it('an install that claims this very device\'s id is never offered anything', async () => {
    const net = new MockNet()
    const o = await node()
    o.e.approvedDevice = () => true
    await makeBoard(o)
    const twin = await node(undefined, o.e.identity, o.e.dev)
    net.link(o.e, twin.e, o.e.self.board)
    await net.settle()
    expect(twin.e.records()).toHaveLength(0)
  })

  it('a board removed from one device\'s list stays off it', async () => {
    const net = new MockNet()
    const o = await node()
    o.e.approvedDevice = () => true
    const b = await makeBoard(o)
    const phone = await node(undefined, o.e.identity)
    const first = net.link(o.e, phone.e, o.e.self.board)
    await net.settle()
    await phone.e.setHidden(b, true)
    net.unlink(first)
    net.link(o.e, phone.e, o.e.self.board)
    await net.settle()
    expect(phone.e.records().map((r) => [r.id, r.hidden])).toEqual([[b, 1]])
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
 * can make `b` an install from before `look` and attachments: its `hi` lacks
 * those flags.
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
    sendBin: async (data, meta) => {
      seen.toB.push('piece')
      net.track(Promise.resolve().then(() => eb.sync.onPiece(b, data.slice(), { ...meta })))
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
      if (bIsOld && auth?.step === 'hi') {
        delete auth.look
        delete auth.blob
      }
      net.track(Promise.resolve().then(() => ea.sync.onMessage(a, action, copy)))
    },
    sendBin: async (data, meta) => {
      seen.toA.push('piece')
      net.track(Promise.resolve().then(() => ea.sync.onPiece(a, data.slice(), { ...meta })))
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

  it('members see who is writing a comment, until they stop', async () => {
    const { net, o, x, b, card } = await shared()
    net.link(o.e, x.e, b)
    await net.settle()
    x.e.sync.look({ board: b, card, typing: true })
    await net.settle()
    expect(o.e.sync.writers(b)).toEqual({ [card]: [x.pub] })
    expect(o.e.sync.lookers(b)).toEqual({ [card]: [x.pub] }) // writing is viewing too
    x.e.sync.look({ board: b, card })
    await net.settle()
    expect(o.e.sync.writers(b)).toEqual({})
    expect(o.e.sync.lookers(b)).toEqual({ [card]: [x.pub] })
    x.e.sync.look({ board: b, card, typing: true })
    await net.settle()
    x.e.sync.look(null) // closing the card stops it too
    await net.settle()
    expect(o.e.sync.writers(b)).toEqual({})
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

describe('activity', () => {
  it('reports what others write once, never my own, nor what was there before I joined', async () => {
    let t = 1_000_000
    const now = () => t
    const net = new MockNet()
    const o = await node(now)
    const x = await node(now)
    const b = await makeBoard(o)
    await addCard(o, b, 'old')
    await grant(o, b, x, 'editor')
    t += 1000
    await x.e.follow(b, null)
    const seen: string[] = []
    x.e.events.on('activity', ({ board, items }) => {
      for (const i of items) seen.push(`${board === b}:${i.op.k}:${i.author === o.pub}`)
    })
    net.link(o.e, x.e, b)
    await net.settle()
    expect(titles(x, b)).toEqual(['old'])
    expect(seen).toEqual([]) // history from before the join

    t += 1000
    await addCard(o, b, 'new')
    await net.settle()
    expect(seen).toEqual(['true:card.create:true'])
    await addCard(x, b, 'mine')
    await net.settle()
    expect(seen).toHaveLength(1)

    // a restart folds it all again from storage: nothing is new
    const again = new Engine(() => x.db, x.e.identity, toB64url(randomBytes(16)), { debounceMs: 0, now })
    const later: unknown[] = []
    again.events.on('activity', (a) => later.push(a))
    await again.loadAll()
    expect(again.view(b)!.cards.size).toBe(3)
    expect(later).toEqual([])
  })
})

describe('attachments', () => {
  function bytes(n: number): Uint8Array {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i += 65536) out.set(randomBytes(Math.min(65536, n - i)), i)
    return out
  }

  /** What the UI does: seal, keep the pieces, then write the op. */
  async function upload(n: Node, board: string, card: string, data: Uint8Array): Promise<Attachment> {
    const sealed = await sealFile(data)
    await n.e.blobs.put(sealed.root, sealed.pieces.length, sealed.pieces.map((p, i) => [i, p] as [number, Uint8Array]), true)
    n.e.swarm.markComplete(sealed.root)
    const op = attachOp(card, { name: 'f.bin', mime: '', size: data.length, ps: PIECE_SIZE, sealed, thumb: null, w: null, h: null })
    await n.e.write([opItem(n.e.view(board)!, op)])
    return n.e.view(board)!.blobs.get(sealed.root)!
  }

  async function fileOf(n: Node, at: Attachment): Promise<Uint8Array | null> {
    const pieces = await n.e.blobs.read(at.root)
    if (!pieces) return null
    const key = fromB64url(at.key)
    return new Uint8Array(Buffer.concat(pieces.map((p, i) => openPiece(key, i, at.n, p)!)))
  }

  async function team(...roles: Array<Exclude<Role, 'owner'>>): Promise<{ o: Node; others: Node[]; b: string; card: string }> {
    const o = await node()
    const b = await makeBoard(o)
    await addCard(o, b, 'c')
    const others: Node[] = []
    for (const role of roles) {
      const x = await node()
      await grant(o, b, x, role)
      await x.e.follow(b, null)
      others.push(x)
    }
    return { o, others, b, card: [...o.e.view(b)!.cards.keys()][0]! }
  }

  it('a member gets the file, and passes it on once its uploader is gone', async () => {
    const { o, others: [x, y], b, card } = await team('editor', 'viewer')
    const data = bytes(PIECE_SIZE * 2 + 99)
    const at = await upload(o, b, card, data)
    const net = new MockNet()
    const ox = net.link(o.e, x.e, b)
    await settleAll(net, o, x)
    expect(await fileOf(x!, at)).toEqual(data) // fetched by itself: small enough
    net.unlink(ox)
    net.link(x!.e, y!.e, b)
    await settleAll(net, x!, y!)
    expect(await fileOf(y!, at)).toEqual(data)
  })

  it('pieces come from everyone who holds them', async () => {
    const { o, others: [x, y], b, card } = await team('editor', 'editor')
    const at = await upload(o, b, card, bytes(PIECE_SIZE * 4))
    const net = new MockNet()
    const ox = net.link(o.e, x!.e, b)
    await settleAll(net, o, x!)
    net.unlink(ox)
    for (const n of [o, x!]) vi.spyOn(n.e.blobs, 'getPiece')
    net.link(o.e, y!.e, b)
    net.link(x!.e, y!.e, b)
    await settleAll(net, o, x!, y!)
    expect(await y!.e.blobs.complete(at.root)).toBe(true)
    expect(vi.mocked(o.e.blobs.getPiece).mock.calls.length).toBeGreaterThan(0)
    expect(vi.mocked(x!.e.blobs.getPiece).mock.calls.length).toBeGreaterThan(0)
  })

  it('files over the limit wait until someone opens them', async () => {
    const { o, others: [x], b, card } = await team('editor')
    x!.e.eagerLimit = () => PIECE_SIZE
    const at = await upload(o, b, card, bytes(PIECE_SIZE * 3))
    const net = new MockNet()
    net.link(o.e, x!.e, b)
    await settleAll(net, o, x!)
    expect(x!.e.view(b)!.blobs.has(at.root)).toBe(true)
    expect(await x!.e.blobs.record(at.root)).toBeNull()
    const got = x!.e.swarm.want(b, at)
    await settleAll(net, o, x!)
    await got
    expect(await x!.e.blobs.complete(at.root)).toBe(true)
  })

  it('a non-member, or a member of another board, gets no piece', async () => {
    const { o, others: [x], b, card } = await team('editor')
    const other = await makeBoard(o)
    const y = await node()
    await grant(o, other, x!, 'editor')
    await x!.e.follow(other, null)
    await y.e.follow(b, null)
    x!.e.eagerLimit = () => 0
    const at = await upload(o, b, card, bytes(1000))
    vi.spyOn(o.e.blobs, 'getPiece')
    const net = new MockNet()
    net.link(o.e, y.e, b) // knows the board id, is not on it
    net.link(o.e, x!.e, other)
    await settleAll(net, o, x!, y)
    // asking through a board the file is not on
    void x!.e.swarm.want(other, at)
    void y.e.swarm.want(b, at)
    await settleAll(net, o, x!, y)
    for (const n of [x!.e, y.e]) n.swarm.tick()
    await settleAll(net, o, x!, y)
    expect(vi.mocked(o.e.blobs.getPiece)).not.toHaveBeenCalled()
    expect(await y.e.blobs.record(at.root)).toBeNull()
    expect(await x!.e.blobs.record(at.root)).toBeNull()
  })

  it('a wrong piece is refused and fetched from someone else', async () => {
    const { o, others: [x, y], b, card } = await team('editor', 'editor')
    const data = bytes(5000)
    const at = await upload(o, b, card, data)
    const net = new MockNet()
    const ox = net.link(o.e, x!.e, b)
    await settleAll(net, o, x!)
    net.unlink(ox)
    // x's copy goes bad on disk
    const bad = (await x!.db.get('pieces', [at.root, 0]))!.slice()
    bad[0]! ^= 0xff
    await x!.db.put('pieces', bad, [at.root, 0])
    net.link(x!.e, y!.e, b)
    await settleAll(net, x!, y!)
    expect(await y!.e.blobs.record(at.root)).toBeNull()
    net.link(o.e, y!.e, b)
    await settleAll(net, o, x!, y!)
    expect(await fileOf(y!, at)).toEqual(data)
  })

  it('a board carried over another board\'s connection brings its files too', async () => {
    const o = await node()
    const x = await node()
    const [b1, b2] = [await makeBoard(o), await makeBoard(o)]
    for (const b of [b1, b2]) {
      await grant(o, b, x, 'editor')
      await x.e.follow(b, null)
    }
    await addCard(o, b2, 'c')
    const data = bytes(PIECE_SIZE + 1)
    const at = await upload(o, b2, [...o.e.view(b2)!.cards.keys()][0]!, data)
    const net = new MockNet()
    net.link(o.e, x.e, b1)
    await settleAll(net, o, x)
    expect(await fileOf(x, at)).toEqual(data)
  })

  it('files of a board taken up from another of my devices wait until opened there', async () => {
    const o = await node()
    o.e.approvedDevice = () => true
    const b = await makeBoard(o)
    await addCard(o, b, 'c')
    const at = await upload(o, b, [...o.e.view(b)!.cards.keys()][0]!, bytes(PIECE_SIZE + 1))
    const phone = await node(undefined, o.e.identity)
    // what state/store.ts does with the event
    const limits = new Map<string, number>()
    phone.e.eagerLimit = (board) => limits.get(board) ?? DEFAULT_EAGER_BYTES
    phone.e.events.on('adopted', ({ board }) => limits.set(board, 0))
    const net = new MockNet()
    net.link(o.e, phone.e, o.e.self.board)
    await settleAll(net, o, phone)
    expect(phone.e.view(b)!.blobs.has(at.root)).toBe(true)
    expect(await phone.e.blobs.record(at.root)).toBeNull()
    const got = phone.e.swarm.want(b, at)
    await settleAll(net, o, phone)
    await got
    expect(await phone.e.blobs.complete(at.root)).toBe(true)
  })

  it('an install from before attachments is never sent `bl` or a piece', async () => {
    const { o, others: [x], b, card } = await team('editor')
    await upload(o, b, card, bytes(1000))
    const net = new MockNet()
    const seen = tapLink(net, o.e, x!.e, b, true)
    await settleAll(net, o, x!)
    expect(seen.toB.filter((a) => a.endsWith('bl') || a === 'piece')).toEqual([])
  })

  it('the store drops files no board names any more, then the oldest unpinned ones past its budget', async () => {
    let t = 1_000_000
    const n = await node(() => t)
    const keep = async (root: string, size: number, pinned: boolean) => {
      await n.e.blobs.put(root, 1, [[0, new Uint8Array(size)]], pinned)
      t += 1000
    }
    const [dead, old, mine, fresh] = ['dead', 'old', 'mine', 'fresh'].map((s) => s.padEnd(43, 'A'))
    await keep(dead!, 10, false)
    await keep(old!, 100, false)
    await keep(mine!, 100, true)
    await keep(fresh!, 100, false)
    const live = (r: string) => r !== dead
    expect(await n.e.blobs.gc(live, 1000, 60_000)).toEqual([]) // not unused long enough
    t += 60_000
    expect((await n.e.blobs.gc(live, 250, 60_000)).sort()).toEqual([dead, old].sort())
    expect(await n.e.blobs.complete(mine!)).toBe(true)
    expect(await n.e.blobs.complete(fresh!)).toBe(true)
  })
})
