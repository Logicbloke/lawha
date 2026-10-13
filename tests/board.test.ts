import { describe, expect, it } from 'vitest'
import { Peer, cardTitles, syncAll } from './sim'
import {
  createBoardItems,
  moveCardsItems,
  moveCardsToBoardItems,
  moveColumnItem,
  movedCardId,
  newEntityId,
  opItem,
  setRoleItem,
} from '../src/core/actions'
import { freshPositions, positionsAt, opSchemaError, type BoardView } from '../src/core/board'

function newBoard(owner: Peer, name = 'Board', columns = ['Todo', 'Doing', 'Done']): string {
  const { id, items } = createBoardItems(owner.id, { kind: 'board', ws: null, name, myName: owner.label, columns })
  owner.write(items)
  return id
}

function col(v: BoardView, name: string): string {
  return v.columns.find((c) => c.name === name)!.id
}

function addCard(p: Peer, board: string, title: string, column = 'Todo', extra: Partial<{ labels: string[]; desc: string }> = {}): string {
  const v = p.view(board)
  const c = col(v, column)
  const id = newEntityId()
  const pos = positionsAt((v.byColumn.get(c) ?? []).map((x) => x.pos), v.byColumn.get(c)?.length ?? 0, 1)[0]!
  p.op(board, {
    k: 'card.create',
    id,
    col: c,
    pos,
    title,
    desc: extra.desc ?? '',
    labels: extra.labels ?? [],
    assignees: [],
    due: null,
    from: null,
  })
  return id
}

function titlesIn(v: BoardView, column: string): string[] {
  return (v.byColumn.get(col(v, column)) ?? []).map((c) => c.title)
}

function twoEditors(): { o: Peer; e: Peer; b: string } {
  const o = new Peer('owner')
  const e = new Peer('editor')
  const b = newBoard(o)
  o.write([setRoleItem(o.view(b), o.id, e.pub, 'editor')])
  syncAll(o, e)
  return { o, e, b }
}

describe('fold', () => {
  it('concurrent edits converge to the same last writer everywhere', () => {
    const { o, e, b } = twoEditors()
    const id = addCard(o, b, 'v0')
    syncAll(o, e)
    o.op(b, { k: 'card.update', id, title: 'owner edit' })
    e.op(b, { k: 'card.update', id, title: 'editor edit' })
    syncAll(o, e)
    const a = o.view(b).cards.get(id)!.title
    expect(e.view(b).cards.get(id)!.title).toBe(a)
    expect(['owner edit', 'editor edit']).toContain(a)
  })

  it('concurrent moves of one card leave it in exactly one column', () => {
    const { o, e, b } = twoEditors()
    const id = addCard(o, b, 'contested')
    syncAll(o, e)
    o.write(moveCardsItems(o.view(b), [id], col(o.view(b), 'Doing'), 0))
    e.write(moveCardsItems(e.view(b), [id], col(e.view(b), 'Done'), 0))
    syncAll(o, e)
    for (const p of [o, e]) {
      const v = p.view(b)
      const where = ['Todo', 'Doing', 'Done'].filter((c) => titlesIn(v, c).includes('contested'))
      expect(where).toHaveLength(1)
    }
    expect(o.view(b).cards.get(id)!.col).toBe(e.view(b).cards.get(id)!.col)
  })

  it('moves a group in order, splitting big groups across several ops', () => {
    const o = new Peer('owner')
    const b = newBoard(o)
    const ids: string[] = []
    for (let i = 0; i < 60; i++) ids.push(addCard(o, b, `c${String(i).padStart(2, '0')}`))
    addCard(o, b, 'stays', 'Done')
    const items = moveCardsItems(o.view(b), ids, col(o.view(b), 'Done'), 0)
    expect(items).toHaveLength(2)
    o.write(items)
    const v = o.view(b)
    expect(titlesIn(v, 'Todo')).toEqual([])
    const done = titlesIn(v, 'Done')
    expect(done).toHaveLength(61)
    expect(done.slice(0, 60)).toEqual(ids.map((_, i) => `c${String(i).padStart(2, '0')}`))
    expect(done[60]).toBe('stays')
  })

  it('inserting next to two cards that landed on the same key still works', () => {
    const { o, e, b } = twoEditors()
    const c = col(o.view(b), 'Todo')
    for (const [p, title] of [[o, 'from o'], [e, 'from e']] as const) {
      p.op(b, { k: 'card.create', id: newEntityId(), col: c, pos: 'a0', title, desc: '', labels: [], assignees: [], due: null, from: null })
    }
    syncAll(o, e)
    expect(titlesIn(o.view(b), 'Todo')).toHaveLength(2)
    const id = addCard(o, b, 'between')
    o.write(moveCardsItems(o.view(b), [id], c, 1))
    expect(titlesIn(o.view(b), 'Todo')).toHaveLength(3)
    expect(positionsAt(['a0', 'a0', 'a1'], 1, 1)[0]! > 'a0').toBe(true)
  })

  it('reorders columns', () => {
    const o = new Peer('owner')
    const b = newBoard(o)
    o.write([moveColumnItem(o.view(b), col(o.view(b), 'Done'), 0)])
    expect(o.view(b).columns.map((c) => c.name)).toEqual(['Done', 'Todo', 'Doing'])
  })

  it('cards of an archived column wait in the unsorted lane; archiving a card can be undone', () => {
    const o = new Peer('owner')
    const b = newBoard(o)
    const id = addCard(o, b, 'orphaned', 'Doing')
    o.op(b, { k: 'column.update', id: col(o.view(b), 'Doing'), archived: true })
    expect(o.view(b).unsorted.map((c) => c.title)).toEqual(['orphaned'])
    o.op(b, { k: 'card.update', id, archived: true })
    expect(o.view(b).archivedCards).toHaveLength(1)
    o.op(b, { k: 'card.update', id, archived: false })
    expect(o.view(b).unsorted).toHaveLength(1)
  })

  it('comments attach to their card in time order', () => {
    const o = new Peer('owner')
    const b = newBoard(o)
    const id = addCard(o, b, 'discuss')
    o.op(b, { k: 'comment.add', id: newEntityId(), card: id, text: 'first', imported: null })
    o.op(b, { k: 'comment.add', id: newEntityId(), card: id, text: 'second', imported: null })
    expect(o.view(b).cards.get(id)!.comments.map((c) => c.text)).toEqual(['first', 'second'])
  })

  it('rejects malformed ops', () => {
    expect(opSchemaError({ k: 'card.move', moves: [{ id: 'x', col: 'y', pos: 'a0' }] })).not.toBeNull()
    expect(opSchemaError({ k: 'column.create', id: newEntityId(), name: 'x', pos: '!!' })).not.toBeNull()
    expect(opSchemaError({ k: 'profile.set', name: 'ok' })).toBeNull()
    expect(opSchemaError({ k: 'profile.set', name: 'ok', extra: 1 })).not.toBeNull()
  })
})

describe('cross-board moves', () => {
  function setup() {
    const o = new Peer('owner')
    const src = newBoard(o, 'Source')
    const dst = newBoard(o, 'Target', ['Inbox', 'Later'])
    const label = newEntityId()
    o.op(src, { k: 'label.set', id: label, name: 'Bug', color: 'red', archived: false })
    const a = addCard(o, src, 'alpha', 'Todo', { labels: [label], desc: 'details' })
    const bb = addCard(o, src, 'beta')
    o.op(src, { k: 'comment.add', id: newEntityId(), card: a, text: 'note on alpha', imported: null })
    return { o, src, dst, a, bb }
  }

  it('moves a group with labels and comments, leaving stubs behind', () => {
    const { o, src, dst, a, bb } = setup()
    const { items, mapping } = moveCardsToBoardItems(o.view(src), o.view(dst), [a, bb], col(o.view(dst), 'Inbox'), 0)
    o.write(items)
    const s = o.view(src)
    const d = o.view(dst)
    expect(cardTitles(s)).toEqual([])
    expect(s.movedOut.map((c) => c.title).sort()).toEqual(['alpha', 'beta'])
    expect(titlesIn(d, 'Inbox')).toEqual(['alpha', 'beta'])
    const moved = d.cards.get(mapping.get(a)!)!
    expect(moved.desc).toBe('details')
    expect(moved.from).toEqual({ board: src, card: a })
    expect(moved.labels.map((l) => d.labels.get(l)!.name)).toEqual(['Bug'])
    expect(moved.comments.map((c) => c.text)).toEqual(['note on alpha'])
    expect(moved.comments[0]!.imported?.name).toBe('owner')
  })

  it('two people moving the same card to the same board produce one card', () => {
    const o = new Peer('owner')
    const e = new Peer('editor')
    const src = newBoard(o, 'S')
    const dst = newBoard(o, 'D')
    o.write([setRoleItem(o.view(src), o.id, e.pub, 'editor')])
    o.write([setRoleItem(o.view(dst), o.id, e.pub, 'editor')])
    const id = addCard(o, src, 'shared')
    syncAll(o, e)
    o.write(moveCardsToBoardItems(o.view(src), o.view(dst), [id], col(o.view(dst), 'Todo'), 0).items)
    e.write(moveCardsToBoardItems(e.view(src), e.view(dst), [id], col(e.view(dst), 'Doing'), 0).items)
    syncAll(o, e)
    const d = o.view(dst)
    expect(cardTitles(d)).toEqual(['shared'])
    expect(d.cards.has(movedCardId(src, id, dst))).toBe(true)
  })

  it('moves to two different boards may duplicate a card but never lose it', () => {
    const o = new Peer('owner')
    const e = new Peer('editor')
    const src = newBoard(o, 'S')
    const d1 = newBoard(o, 'D1')
    const d2 = newBoard(o, 'D2')
    for (const bd of [src, d1, d2]) o.write([setRoleItem(o.view(bd), o.id, e.pub, 'editor')])
    const id = addCard(o, src, 'wanderer')
    syncAll(o, e)
    o.write(moveCardsToBoardItems(o.view(src), o.view(d1), [id], col(o.view(d1), 'Todo'), 0).items)
    e.write(moveCardsToBoardItems(e.view(src), e.view(d2), [id], col(e.view(d2), 'Todo'), 0).items)
    syncAll(o, e)
    expect(cardTitles(o.view(d1)) .concat(cardTitles(o.view(d2)))).toEqual(['wanderer', 'wanderer'])
    expect(o.view(src).movedOut).toHaveLength(1)
  })

  it('an edit to the stub after the move is flagged', () => {
    const { o, src, dst, a } = setup()
    const e = new Peer('late editor')
    o.write([setRoleItem(o.view(src), o.id, e.pub, 'editor')])
    e.pull(o)
    o.write(moveCardsToBoardItems(o.view(src), o.view(dst), [a], col(o.view(dst), 'Inbox'), 0).items)
    e.op(src, { k: 'card.update', id: a, title: 'edited concurrently' })
    syncAll(o, e)
    expect(o.view(src).cards.get(a)!.editedAfterMove).toBe(true)
  })
})

describe('performance', () => {
  it('re-folds a 20k-op board in well under a second with a warm cache', () => {
    const o = new Peer('owner')
    const b = newBoard(o)
    const v = o.view(b)
    const c = col(v, 'Todo')
    const items = []
    const ids: string[] = []
    const keys = freshPositions(4000)
    for (let i = 0; i < 4000; i++) {
      const id = newEntityId()
      ids.push(id)
      items.push({ k: 'card.create' as const, id, col: c, pos: keys[i]!, title: `card ${i}`, desc: '', labels: [], assignees: [], due: null, from: null })
    }
    o.write(items.map((op) => opItem(v, op)))
    const updates = []
    for (let i = 0; i < 16000; i++) updates.push({ k: 'card.update' as const, id: ids[i % ids.length]!, title: `t${i}` })
    o.write(updates.map((op) => opItem(v, op)))
    o.view(b) // warm the decrypt cache
    const t0 = performance.now()
    const warm = o.view(b)
    const ms = performance.now() - t0
    expect(warm.cards.size).toBe(4000)
    expect(ms).toBeLessThan(300)
    console.log(`warm fold of ${o.msgs.size} envelopes: ${ms.toFixed(0)} ms`)
  }, 120_000)
})
