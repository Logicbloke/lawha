import { describe, expect, it } from 'vitest'
import { Peer, syncAll } from './sim'
import { attachOp, createBoardItems, moveCardsItems, newEntityId, opItem, setRoleItem } from '../src/core/actions'
import { PIECE_SIZE, sealFile } from '../src/core/blobcrypto'
import { positionsAt, type BoardView } from '../src/core/board'
import { mentionToken, mentionedPubs, plainMentions, splitMentions } from '../src/core/mentions'
import { notesFor, type NotifyPrefs } from '../src/state/notify'

const NONE: NotifyPrefs = { all: false, columns: [], assigned: false, involved: false, mentions: false }

function col(v: BoardView, name: string): string {
  return v.columns.find((c) => c.name === name)!.id
}

function card(v: BoardView, title: string): string {
  return [...v.cards.values()].find((c) => c.title === title)!.id
}

function addCard(p: Peer, board: string, title: string, column: string): string {
  const v = p.view(board)
  const c = col(v, column)
  const id = newEntityId()
  const pos = positionsAt((v.byColumn.get(c) ?? []).map((x) => x.pos), v.byColumn.get(c)?.length ?? 0, 1)[0]!
  p.op(board, { k: 'card.create', id, col: c, pos, title, desc: '', labels: [], assignees: [], due: null, from: null })
  return id
}

/** Olga owns a board Erik edits, with card A in Todo. */
function setup() {
  const o = new Peer('Olga')
  const e = new Peer('Erik')
  const { id: b, items } = createBoardItems(o.id, { kind: 'board', ws: null, name: 'Board', myName: 'Olga', columns: ['Todo', 'Doing', 'Done'] })
  o.write(items)
  o.write([setRoleItem(o.view(b), o.id, e.pub, 'editor')])
  addCard(o, b, 'A', 'Todo')
  syncAll(o, e)
  /** What Erik is told about what `fn` makes Olga (or Erik) write. */
  const told = (prefs: NotifyPrefs, fn: () => void): string[] => {
    const before = e.view(b)
    fn()
    syncAll(o, e)
    const after = e.view(b)
    const seen = new Set(before.ops.map((x) => x.id))
    const items = after.ops.filter((x) => !seen.has(x.id) && x.author !== e.pub)
    return notesFor(items, before, after, e.pub, prefs).map((n) => n.text)
  }
  return { o, e, b, told }
}

describe('notifications', () => {
  it('a column: cards added, moved in or out, but not reordered or elsewhere', () => {
    const { o, b, told } = setup()
    const doing = col(o.view(b), 'Doing')
    const prefs = { ...NONE, columns: [doing] }
    expect(told(prefs, () => addCard(o, b, 'Elsewhere', 'Todo'))).toEqual([])
    expect(told(prefs, () => addCard(o, b, 'B', 'Doing'))).toEqual(['Olga added “B” to Doing'])
    const a = card(o.view(b), 'A')
    expect(told(prefs, () => o.write(moveCardsItems(o.view(b), [a], doing, 1)))).toEqual(['Olga moved “A” to Doing'])
    expect(told(prefs, () => o.write(moveCardsItems(o.view(b), [a], doing, 0)))).toEqual([])
    expect(told(prefs, () => o.write(moveCardsItems(o.view(b), [a], col(o.view(b), 'Done'), 0)))).toEqual(['Olga moved “A” to Done'])
  })

  it('cards assigned to me, from the moment I am assigned', () => {
    const { o, e, b, told } = setup()
    const a = card(o.view(b), 'A')
    const prefs = { ...NONE, assigned: true }
    expect(told(prefs, () => o.op(b, { k: 'card.update', id: a, desc: 'before' }))).toEqual([])
    expect(told(prefs, () => o.op(b, { k: 'card.update', id: a, assignees: [e.pub] }))).toEqual(['Olga assigned you to “A”'])
    expect(told(prefs, () => o.op(b, { k: 'card.update', id: a, title: 'A2' }))).toEqual(['Olga edited “A2”'])
    expect(told(prefs, () => o.op(b, { k: 'card.update', id: a, archived: true }))).toEqual(['Olga archived “A2”'])
  })

  it('cards I created, edited or commented on', () => {
    const { o, e, b, told } = setup()
    const a = card(o.view(b), 'A')
    const prefs = { ...NONE, involved: true }
    expect(told(prefs, () => o.op(b, { k: 'comment.add', id: newEntityId(), card: a, text: 'first', imported: null }))).toEqual([])
    e.op(b, { k: 'comment.add', id: newEntityId(), card: a, text: 'me too', imported: null })
    expect(told(prefs, () => o.op(b, { k: 'comment.add', id: newEntityId(), card: a, text: 'thanks', imported: null }))).toEqual([
      'Olga commented on “A”: thanks',
    ])
    const mine = addCard(e, b, 'Mine', 'Todo')
    expect(told(prefs, () => o.op(b, { k: 'card.update', id: mine, desc: 'x' }))).toEqual(['Olga edited “Mine”'])
  })

  it('a file added to a card I am involved in, by its name', async () => {
    const { o, e, b, told } = setup()
    const a = card(o.view(b), 'A')
    e.op(b, { k: 'comment.add', id: newEntityId(), card: a, text: 'on it', imported: null })
    syncAll(o, e)
    const sealed = await sealFile(new Uint8Array(10))
    const op = () => attachOp(a, { name: 'spec.pdf', mime: 'application/pdf', size: 10, ps: PIECE_SIZE, sealed, thumb: null, w: null, h: null })
    expect(told({ ...NONE, involved: true }, () => o.write([opItem(o.view(b), op())]))).toEqual(['Olga attached spec.pdf to “A”'])
    expect(told(NONE, () => o.write([opItem(o.view(b), op())]))).toEqual([])
  })

  it('mentions, shown by name, even on cards I have nothing to do with', () => {
    const { o, e, b, told } = setup()
    const a = card(o.view(b), 'A')
    const text = `${mentionToken('Erik', e.pub)} can you look?`
    const comment = () => o.op(b, { k: 'comment.add', id: newEntityId(), card: a, text, imported: null })
    expect(told({ ...NONE, mentions: true }, comment)).toEqual(['Olga mentioned you on “A”: @Erik can you look?'])
    expect(told(NONE, comment)).toEqual([])
  })

  it('everything on the board, one note per card', () => {
    const { o, b, told } = setup()
    const a = card(o.view(b), 'A')
    const prefs = { ...NONE, all: true }
    expect(told(prefs, () => o.op(b, { k: 'column.update', id: col(o.view(b), 'Done'), name: 'Shipped' }))).toEqual(['Olga changed the board'])
    expect(
      told(prefs, () => {
        o.op(b, { k: 'card.update', id: a, title: 'A2' })
        o.op(b, { k: 'comment.add', id: newEntityId(), card: a, text: 'renamed', imported: null })
      }),
    ).toEqual(['Olga edited “A2”'])
  })
})

describe('mentions', () => {
  const pub = 'x'.repeat(43)

  it('round-trips through the comment text', () => {
    const text = `hi ${mentionToken('Sam', pub)}, and ${mentionToken('Bad]name\nhere', pub)}`
    expect(mentionedPubs(text)).toEqual(new Set([pub]))
    expect(splitMentions(text)).toEqual([
      { text: 'hi ' },
      { name: 'Sam', pub },
      { text: ', and ' },
      { name: 'Bad name here', pub },
    ])
    expect(plainMentions(text)).toBe('hi @Sam, and @Bad name here')
    expect(plainMentions(text, () => 'Samantha')).toBe('hi @Samantha, and @Samantha')
  })

  it('leaves look-alikes as text', () => {
    expect(splitMentions('@[Sam](short) mail@x.com')).toEqual([{ text: '@[Sam](short) mail@x.com' }])
  })
})
