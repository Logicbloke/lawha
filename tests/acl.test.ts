import { describe, expect, it } from 'vitest'
import { Peer, cardTitles, roleOfView, syncAll } from './sim'
import {
  createBoardItems,
  leaveItem,
  newEntityId,
  opItem,
  removeItem,
  rotateItem,
  setRoleItem,
} from '../src/core/actions'
import { createEnvelope, msgId } from '../src/core/envelope'
import { sealOp } from '../src/core/boardcrypto'
import type { BoardView } from '../src/core/board'
import type { OpContent, RotateAcl, StoredMessage } from '../src/core/types'

function newBoard(owner: Peer, name = 'Board'): string {
  const { id, items } = createBoardItems(owner.id, {
    kind: 'board',
    ws: null,
    name,
    myName: owner.label,
    columns: ['Todo', 'Doing', 'Done'],
  })
  owner.write(items)
  return id
}

function firstColumn(view: BoardView): string {
  return view.columns[0]!.id
}

function addCard(p: Peer, board: string, title: string): StoredMessage {
  const v = p.view(board)
  return p.op(board, {
    k: 'card.create',
    id: newEntityId(),
    col: firstColumn(v),
    pos: 'a' + String(v.cards.size).padStart(1, '0'),
    title,
    desc: '',
    labels: [],
    assignees: [],
    due: null,
    from: null,
  })
}

describe('board basics', () => {
  it('genesis gives the creator ownership, a name and columns', () => {
    const o = new Peer('owner')
    const b = newBoard(o, 'Roadmap')
    const v = o.view(b)
    expect(v.owner).toBe(o.pub)
    expect(v.myRole).toBe('owner')
    expect(v.name).toBe('Roadmap')
    expect(v.columns.map((c) => c.name)).toEqual(['Todo', 'Doing', 'Done'])
    expect(v.profiles.get(o.pub)).toBe('owner')
  })

  it('a non-member learns nothing: no key, no content', () => {
    const o = new Peer('owner')
    const x = new Peer('stranger')
    const b = newBoard(o)
    addCard(o, b, 'secret plan')
    x.pull(o)
    const v = x.view(b)
    expect(v.myRole).toBe('none')
    expect(v.writerEpoch).toBeNull()
    expect(v.cards.size).toBe(0)
    expect(v.name).toBe('')
    expect(v.stats.undecryptable).toBeGreaterThan(0)
  })
})

describe('roles', () => {
  it('an editor can add cards but not rename the board; a viewer only names itself', () => {
    const o = new Peer('owner')
    const e = new Peer('editor')
    const vw = new Peer('viewer')
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, e.pub, 'editor')])
    o.write([setRoleItem(o.view(b), o.id, vw.pub, 'viewer')])
    syncAll(o, e, vw)

    addCard(e, b, 'from editor')
    e.write([opItem(e.view(b), { k: 'board.update', name: 'hijacked' })])
    addCard(vw, b, 'from viewer')
    vw.op(b, { k: 'profile.set', name: 'Vee' })
    syncAll(o, e, vw)

    const v = o.view(b)
    expect(cardTitles(v)).toEqual(['from editor'])
    expect(v.name).toBe('Board')
    expect(v.profiles.get(vw.pub)).toBe('Vee')
    expect(v.stats.rejected).toBe(2)
  })

  it('admins manage editors but cannot touch other admins', () => {
    const o = new Peer('owner')
    const a = new Peer('admin')
    const a2 = new Peer('admin2')
    const e = new Peer('editor')
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, a.pub, 'admin')])
    o.write([setRoleItem(o.view(b), o.id, a2.pub, 'admin')])
    syncAll(o, a, a2, e)
    a.write([setRoleItem(a.view(b), a.id, e.pub, 'editor')])
    expect(() => a.write([removeItem(a.view(b), a.id, a2.pub)])).toThrow()
    syncAll(o, a, a2, e)
    expect(roleOfView(o.view(b), e.pub)).toBe('editor')
    expect(roleOfView(o.view(b), a2.pub)).toBe('admin')
  })

  it('a forged remove of an admin by an admin is ignored', () => {
    const o = new Peer('owner')
    const a = new Peer('admin')
    const a2 = new Peer('admin2')
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, a.pub, 'admin')])
    o.write([setRoleItem(o.view(b), o.id, a2.pub, 'admin')])
    syncAll(o, a, a2)
    // bypass the client-side guard by building the ACL op directly
    const v = a.view(b)
    a.write([
      {
        board: b,
        type: 'acl',
        dep: v.maxClockId,
        build: () => ({ act: 'remove', acl: v.aclHeads, target: a2.pub, upTo: {}, epoch: removeEpochFor(v, a2.pub) }),
      },
    ])
    syncAll(o, a, a2)
    expect(roleOfView(o.view(b), a2.pub)).toBe('admin')
  })
})

/** an epoch blob, borrowed from a legitimate rotate build */
function removeEpochFor(v: BoardView, _target: string) {
  const item = rotateItem({ ...v, myRole: 'admin' })
  const c = item.build({ board: v.id, author: '', dev: '', seq: 1, prior: [] })
  if (!('epoch' in c) || typeof c.epoch !== 'object') throw new Error('no epoch')
  return c.epoch
}

describe('removal and cutoffs', () => {
  it('ops written after removal are cut; ops the remover saw survive', () => {
    const o = new Peer('owner')
    const e = new Peer('editor')
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, e.pub, 'editor')])
    syncAll(o, e)
    addCard(e, b, 'before')
    syncAll(o, e)
    o.write([removeItem(o.view(b), o.id, e.pub)])
    // e has not seen the removal
    addCard(e, b, 'after')
    syncAll(o, e)
    const v = o.view(b)
    expect(cardTitles(v)).toEqual(['before'])
    expect(roleOfView(v, e.pub)).toBe('none')
    expect(roleOfView(e.view(b), e.pub)).toBe('none')
  })

  it('a removed member cannot backdate: old ACL refs do not help', () => {
    const o = new Peer('owner')
    const e = new Peer('editor')
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, e.pub, 'editor')])
    syncAll(o, e)
    const stale = e.view(b) // pre-removal view: old ACL heads, old key
    o.write([removeItem(o.view(b), o.id, e.pub)])
    syncAll(o, e)
    e.write([
      opItem(stale, {
        k: 'card.create',
        id: newEntityId(),
        col: firstColumn(stale),
        pos: 'a5',
        title: 'backdated',
        desc: '',
        labels: [],
        assignees: [],
        due: null,
        from: null,
      }),
    ])
    syncAll(o, e)
    expect(cardTitles(o.view(b))).toEqual([])
  })

  it('a removed admin cannot keep issuing ACL ops with backdated deps', () => {
    const o = new Peer('owner')
    const a = new Peer('adminA')
    const c = new Peer('adminC')
    const e = new Peer('editorE')
    const f = new Peer('editorF')
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, a.pub, 'admin')])
    o.write([setRoleItem(o.view(b), o.id, c.pub, 'admin')])
    o.write([setRoleItem(o.view(b), o.id, e.pub, 'editor')])
    o.write([setRoleItem(o.view(b), o.id, f.pub, 'editor')])
    syncAll(o, a, c, e, f)
    // C writes X; owner sees X and removes A
    c.write([rotateItem(c.view(b))])
    o.pull(c)
    o.write([removeItem(o.view(b), o.id, a.pub)])
    // A never saw X or the removal: removes E, then F, both on stale deps
    a.write([removeItem(a.view(b), a.id, e.pub)])
    a.write([removeItem(a.view(b), a.id, f.pub)])
    syncAll(o, a, c, e, f)
    for (const p of [o, c, e, f]) {
      const v = p.view(b)
      expect(roleOfView(v, a.pub)).toBe('none')
      expect(roleOfView(v, e.pub)).toBe('editor')
      expect(roleOfView(v, f.pub)).toBe('editor')
    }
  })

  it('a removal beats a concurrent grant on the same member', () => {
    const o = new Peer('owner')
    const a = new Peer('adminA')
    const c = new Peer('adminC')
    const e = new Peer('editorE')
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, a.pub, 'admin')])
    o.write([setRoleItem(o.view(b), o.id, c.pub, 'admin')])
    o.write([setRoleItem(o.view(b), o.id, e.pub, 'viewer')])
    syncAll(o, a, c, e)
    a.write([removeItem(a.view(b), a.id, e.pub)])
    c.write([setRoleItem(c.view(b), c.id, e.pub, 'editor')])
    syncAll(o, a, c, e)
    for (const p of [o, a, c, e]) expect(roleOfView(p.view(b), e.pub)).toBe('none')
  })

  it('the owner beats an admin on concurrent role events', () => {
    const o = new Peer('owner')
    const a = new Peer('adminA')
    const e = new Peer('editorE')
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, a.pub, 'admin')])
    o.write([setRoleItem(o.view(b), o.id, e.pub, 'viewer')])
    syncAll(o, a, e)
    a.write([removeItem(a.view(b), a.id, e.pub)])
    o.write([setRoleItem(o.view(b), o.id, e.pub, 'editor')])
    syncAll(o, a, e)
    for (const p of [o, a, e]) expect(roleOfView(p.view(b), e.pub)).toBe('editor')
  })

  it('a re-added member counts again only once they have seen the re-add', () => {
    const o = new Peer('owner')
    const e = new Peer('editor')
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, e.pub, 'editor')])
    syncAll(o, e)
    o.write([removeItem(o.view(b), o.id, e.pub)])
    addCard(e, b, 'during removal') // e unaware
    o.write([setRoleItem(o.view(b), o.id, e.pub, 'editor')])
    syncAll(o, e)
    addCard(e, b, 'after re-add')
    syncAll(o, e)
    expect(cardTitles(o.view(b))).toEqual(['after re-add'])
  })

  it('a device the remover never saw is cut entirely', () => {
    const o = new Peer('owner')
    const e1 = new Peer('e-phone')
    const e2 = new Peer('e-laptop', e1.id) // same key, second device
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, e1.pub, 'editor')])
    syncAll(o, e1, e2)
    addCard(e2, b, 'laptop card') // o never sees it before removing
    o.write([removeItem(o.view(b), o.id, e1.pub)])
    syncAll(o, e1, e2)
    expect(cardTitles(o.view(b))).toEqual([])
  })

  it('two devices of one member write independent chains without forking', () => {
    const o = new Peer('owner')
    const e1 = new Peer('e-phone')
    const e2 = new Peer('e-laptop', e1.id)
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, e1.pub, 'editor')])
    syncAll(o, e1, e2)
    addCard(e1, b, 'phone')
    addCard(e2, b, 'laptop')
    syncAll(o, e1, e2)
    const v = o.view(b)
    expect(cardTitles(v)).toEqual(['laptop', 'phone'])
    expect(v.members.find((m) => m.pub === e1.pub)!.devices).toHaveLength(2)
    expect(v.stats.forkedDevices).toBe(0)
  })

  it('a member who leaves loses access after an admin heals the key', () => {
    const o = new Peer('owner')
    const e = new Peer('editor')
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, e.pub, 'editor')])
    syncAll(o, e)
    e.write([leaveItem(e.view(b), e.id)])
    syncAll(o, e)
    expect(o.view(b).needsHeal).toBe(true)
    o.write([rotateItem(o.view(b))])
    expect(o.view(b).needsHeal).toBe(false)
    addCard(o, b, 'after leave')
    syncAll(o, e)
    expect(cardTitles(e.view(b))).toEqual([])
    expect(cardTitles(o.view(b))).toEqual(['after leave'])
  })
})

describe('keys and epochs', () => {
  it('a removed member cannot read anything written after the removal', () => {
    const o = new Peer('owner')
    const e = new Peer('editor')
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, e.pub, 'editor')])
    syncAll(o, e)
    addCard(o, b, 'old')
    o.write([removeItem(o.view(b), o.id, e.pub)])
    addCard(o, b, 'new')
    syncAll(o, e)
    // history up to the removal stays readable (documented); nothing after it
    expect(cardTitles(e.view(b))).toEqual(['old'])
    expect(cardTitles(o.view(b))).toEqual(['new', 'old'])
    expect(e.view(b).keys.size).toBe(1)
  })

  it('a member added late reads all history by walking carried keys', () => {
    const o = new Peer('owner')
    const x = new Peer('x')
    const late = new Peer('late')
    const b = newBoard(o)
    addCard(o, b, 'epoch1')
    o.write([setRoleItem(o.view(b), o.id, x.pub, 'editor')])
    o.write([removeItem(o.view(b), o.id, x.pub)])
    addCard(o, b, 'epoch2')
    o.write([rotateItem(o.view(b))])
    addCard(o, b, 'epoch3')
    o.write([setRoleItem(o.view(b), o.id, late.pub, 'viewer')])
    late.pull(o)
    const v = late.view(b)
    expect(v.keys.size).toBe(3)
    expect(cardTitles(v)).toEqual(['epoch1', 'epoch2', 'epoch3'])
  })

  it('a key-splitting epoch gives the cheated member no key instead of a wrong one', () => {
    const o = new Peer('owner')
    const e = new Peer('editor')
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, e.pub, 'editor')])
    syncAll(o, e)
    // two rotations; graft e's wrap from the second onto the first's blob
    const r1 = rotateItem(o.view(b)).build({ board: b, author: o.pub, dev: o.dev, seq: 1, prior: [] }) as RotateAcl
    const r2 = rotateItem(o.view(b)).build({ board: b, author: o.pub, dev: o.dev, seq: 1, prior: [] }) as RotateAcl
    const forged = { ...r1, epoch: { ...r1.epoch, wraps: { ...r1.epoch.wraps, [e.pub]: r2.epoch.wraps[e.pub]! } } }
    o.write([{ board: b, type: 'acl', dep: o.view(b).maxClockId, build: () => forged }])
    e.pull(o)
    expect(e.view(b).keys.has(r1.epoch.id)).toBe(false)
  })

  it('ciphertext is bound to its position: a copy at another seq does not decrypt', () => {
    const o = new Peer('owner')
    const b = newBoard(o)
    const card = addCard(o, b, 'original')
    const v = o.view(b)
    const head = [...o.msgs.values()].filter((m) => m.author === o.pub).sort((x, y) => y.seq - x.seq)[0]!
    const copy = createEnvelope(
      o.id,
      { board: b, dev: o.dev, head: { seq: head.seq, id: head.id }, dep: head.id },
      'op',
      card.content as OpContent,
    )
    o.inject({ ...copy, id: msgId(copy), receivedAt: 0 })
    const after = o.view(b)
    expect(cardTitles(after)).toEqual(['original'])
    expect(after.stats.undecryptable).toBe(v.stats.undecryptable + 1)
  })
})

describe('clocks, holds and forks', () => {
  it('a declared timestamp cannot win last-writer-wins; the derived clock decides', () => {
    const o = new Peer('owner')
    const e = new Peer('editor')
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, e.pub, 'editor')])
    syncAll(o, e)
    const card = addCard(o, b, 'v1')
    syncAll(o, e)
    const id = [...o.view(b).cards.keys()][0]!
    e.ts = 9_000_000_000_000 // far future
    e.op(b, { k: 'card.update', id, title: 'from the future' })
    o.pull(e)
    o.op(b, { k: 'card.update', id, title: 'seen and replaced' })
    e.pull(o)
    expect(cardTitles(e.view(b))).toEqual(['seen and replaced'])
    expect(card).toBeTruthy()
  })

  it('an envelope with a missing dependency is held, not rejected, and applies once it arrives', () => {
    const o = new Peer('owner')
    const e = new Peer('editor')
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, e.pub, 'editor')])
    syncAll(o, e)
    addCard(o, b, 'first')
    const dep = [...o.msgs.values()].sort((x, y) => y.seq - x.seq)[0]!
    e.pull(o)
    addCard(e, b, 'second')
    // a third peer gets e's card but not the owner's latest envelope
    const t = new Peer('third', o.id)
    for (const m of e.msgs.values()) if (m.id !== dep.id) t.inject(m)
    const held = t.view(b)
    expect(held.stats.held).toBeGreaterThan(0)
    expect(cardTitles(held)).toEqual([])
    t.inject(dep)
    expect(cardTitles(t.view(b))).toEqual(['first', 'second'])
  })

  it('a dep pointing nowhere only holds the forger, the board stays writable', () => {
    const o = new Peer('owner')
    const e = new Peer('editor')
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, e.pub, 'editor')])
    syncAll(o, e)
    const v = e.view(b)
    e.write([{ ...opItem(v, { k: 'profile.set', name: 'x' }), dep: 'A'.repeat(43) }])
    syncAll(o, e)
    addCard(o, b, 'still works')
    expect(cardTitles(o.view(b))).toEqual(['still works'])
  })

  it('a fork proof invalidates that device from the fork on', () => {
    const o = new Peer('owner')
    const e = new Peer('editor')
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, e.pub, 'editor')])
    syncAll(o, e)
    addCard(e, b, 'one')
    const two = addCard(e, b, 'two')
    syncAll(o, e)
    const twin = createEnvelope(
      e.id,
      { board: b, dev: e.dev, head: { seq: two.seq - 1, id: two.prev! }, dep: two.dep },
      'op',
      two.content,
      two.ts + 1,
    )
    o.forks = [{ board: b, author: e.pub, dev: e.dev, seq: two.seq, a: two, b: twin }]
    expect(cardTitles(o.view(b))).toEqual(['one'])
    expect(o.view(b).stats.forkedDevices).toBe(1)
  })
})

describe('genesis', () => {
  it('a rival genesis for the same board id from another key is ignored', () => {
    const o = new Peer('owner')
    const m = new Peer('mallory')
    const b = newBoard(o)
    const v = o.view(b)
    const forged = createBoardItems(m.id, { kind: 'board', ws: null, name: 'x', myName: '', columns: [] })
    const g = forged.items[0]!.build({ board: b, author: m.pub, dev: m.dev, seq: 1, prior: [] })
    m.write([{ board: b, type: 'acl', dep: null, build: () => g }])
    o.pull(m)
    expect(o.view(b).owner).toBe(o.pub)
    expect(o.view(b).columns).toHaveLength(v.columns.length)
  })

  it('content ops carry sealed payloads of fixed bucket sizes', () => {
    const o = new Peer('owner')
    const b = newBoard(o)
    const v = o.view(b)
    const small = sealOp(v.writerEpoch!.key, { board: b, author: o.pub, dev: o.dev, seq: 9, epoch: v.writerEpoch!.id }, { k: 'profile.set', name: 'a' })
    const other = sealOp(v.writerEpoch!.key, { board: b, author: o.pub, dev: o.dev, seq: 9, epoch: v.writerEpoch!.id }, { k: 'profile.set', name: 'a much longer display name' })
    expect(small.box.length).toBe(other.box.length)
  })
})
