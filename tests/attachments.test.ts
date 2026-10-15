import { describe, expect, it } from 'vitest'
import { randomBytes } from '@noble/hashes/utils.js'
import { fromB64url, toB64url } from '../src/core/b64'
import { Peer, syncAll } from './sim'
import { createBoardItems, moveCardsToBoardItems, newEntityId, setRoleItem } from '../src/core/actions'
import {
  HASH_BYTES,
  MAX_PIECES,
  PIECE_SIZE,
  openPiece,
  pieceCount,
  pieceMatches,
  rootOf,
  sealFile,
  sealedPieceLen,
} from '../src/core/blobcrypto'
import { opSchemaError, positionsAt, type BoardOp, type BoardView } from '../src/core/board'
import { isInlineImage, isInlineVideo, safeFileName, sniff } from '../src/core/sniff'

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i += 65536) out.set(randomBytes(Math.min(65536, n - i)), i)
  return out
}

async function attachOp(card: string, data: Uint8Array, name = 'f.bin', extra: Partial<BoardOp> = {}): Promise<BoardOp> {
  const s = await sealFile(data)
  return {
    k: 'attach.add',
    id: newEntityId(),
    card,
    name,
    mime: 'application/octet-stream',
    size: data.length,
    ps: PIECE_SIZE,
    hashes: toB64url(s.hashes),
    key: toB64url(s.key),
    thumb: null,
    w: null,
    h: null,
    ...extra,
  } as BoardOp
}

function newBoard(owner: Peer, name = 'Board'): string {
  const { id, items } = createBoardItems(owner.id, { kind: 'board', ws: null, name, myName: owner.label, columns: ['Todo'] })
  owner.write(items)
  return id
}

function addCard(p: Peer, board: string, title: string): string {
  const v = p.view(board)
  const col = v.columns[0]!.id
  const id = newEntityId()
  const pos = positionsAt((v.byColumn.get(col) ?? []).map((c) => c.pos), v.byColumn.get(col)?.length ?? 0, 1)[0]!
  p.op(board, { k: 'card.create', id, col, pos, title, desc: '', labels: [], assignees: [], due: null, from: null })
  return id
}

const atts = (v: BoardView, card: string) => v.cards.get(card)!.attachments

describe('sealed files', () => {
  it('round-trips piece by piece, and the root follows from the hashes', async () => {
    const data = bytes(PIECE_SIZE * 2 + 1234)
    const s = await sealFile(data)
    const n = pieceCount(data.length, PIECE_SIZE)
    expect(n).toBe(3)
    expect(s.pieces).toHaveLength(3)
    expect(s.hashes.length).toBe(3 * HASH_BYTES)
    expect(s.root).toBe(rootOf(s.hashes))
    const out = s.pieces.map((p, i) => {
      expect(p.length).toBe(sealedPieceLen(data.length, PIECE_SIZE, i))
      expect(pieceMatches(s.hashes, i, p)).toBe(true)
      return openPiece(s.key, i, n, p)!
    })
    expect(Buffer.concat(out).equals(Buffer.from(data))).toBe(true)
  })

  it('an empty file is one sealed piece', async () => {
    const s = await sealFile(new Uint8Array(0))
    expect(s.pieces).toHaveLength(1)
    expect(openPiece(s.key, 0, 1, s.pieces[0]!)).toEqual(new Uint8Array(0))
  })

  it('a tampered, swapped or truncated piece does not open or match', async () => {
    const s = await sealFile(bytes(PIECE_SIZE * 2))
    const bad = s.pieces[0]!.slice()
    bad[10]! ^= 1
    expect(openPiece(s.key, 0, 2, bad)).toBeNull()
    expect(pieceMatches(s.hashes, 0, bad)).toBe(false)
    // the right bytes in the wrong place
    expect(openPiece(s.key, 1, 2, s.pieces[0]!)).toBeNull()
    expect(pieceMatches(s.hashes, 1, s.pieces[0]!)).toBe(false)
    // claiming the file ends after its first piece
    expect(openPiece(s.key, 0, 1, s.pieces[0]!)).toBeNull()
    expect(openPiece(randomBytes(32), 0, 2, s.pieces[0]!)).toBeNull()
  })

  it('two uploads of the same bytes are different files (fresh key each)', async () => {
    const data = bytes(1000)
    const [a, b] = [await sealFile(data), await sealFile(data)]
    expect(a.root).not.toBe(b.root)
  })
})

describe('sniffing', () => {
  it('recognises raster images, video and PDF by their bytes, whatever the name says', () => {
    const at = (head: number[] | string) => sniff(typeof head === 'string' ? new TextEncoder().encode(head) : new Uint8Array(head))
    expect(at(PNG)).toBe('image/png')
    expect(at([0xff, 0xd8, 0xff, 0xe0])).toBe('image/jpeg')
    expect(at('GIF89a....')).toBe('image/gif')
    expect(at('RIFF\0\0\0\0WEBPVP8 ')).toBe('image/webp')
    expect(at('\0\0\0\x18ftypisom')).toBe('video/mp4')
    expect(at('\0\0\0\x18ftypavif')).toBe('image/avif')
    expect(at('\0\0\0\x18ftypheic')).toBeNull()
    expect(at('\0\0\0\x18ftypM4A ')).toBeNull()
    expect(at([0x1a, 0x45, 0xdf, 0xa3])).toBe('video/webm')
    expect(at('%PDF-1.7')).toBe('application/pdf')
  })

  it('never shows markup inline: SVG, HTML and PDF are download-only', () => {
    for (const s of ['<svg xmlns="http://www.w3.org/2000/svg"><script>', '<!doctype html><script>', '<?xml version="1.0"?><svg']) {
      const t = sniff(new TextEncoder().encode(s))
      expect(isInlineImage(t) || isInlineVideo(t)).toBe(false)
    }
    expect(isInlineImage(sniff(new TextEncoder().encode('%PDF-1.4')))).toBe(false)
  })

  it('download names lose paths, control characters and bidi overrides', () => {
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd')
    expect(safeFileName('invoice‮fdp.exe')).toBe('invoice_fdp.exe')
    expect(safeFileName('a\u0000b\nc.txt')).toBe('a_b_c.txt')
    expect(safeFileName('...')).toBe('file')
    expect(safeFileName('تقرير.pdf')).toBe('تقرير.pdf')
  })
})

describe('attachment ops', () => {
  it('accept a well-formed op and reject malformed ones', async () => {
    const card = newEntityId()
    const good = (await attachOp(card, bytes(PIECE_SIZE + 1))) as Extract<BoardOp, { k: 'attach.add' }>
    expect(opSchemaError(good)).toBeNull()
    expect(opSchemaError({ ...good, thumb: toB64url(new Uint8Array(PNG)), w: 640, h: 480 })).toBeNull()
    const bad: Array<Record<string, unknown>> = [
      { ...good, extra: 1 },
      { ...good, name: '' },
      { ...good, name: 'x'.repeat(256) },
      { ...good, mime: 'not a type' },
      { ...good, size: -1 },
      { ...good, size: 1.5 },
      // the hash list must match the piece count of the size
      { ...good, size: 10 },
      { ...good, hashes: good.hashes + 'A' },
      { ...good, ps: 3000 },
      { ...good, ps: 1 << 21 },
      { ...good, size: PIECE_SIZE * MAX_PIECES + 1 },
      { ...good, key: 'short' },
      { ...good, thumb: toB64url(new Uint8Array(4097)) },
      { ...good, w: 0 },
      { ...good, card: 'nope' },
    ]
    for (const o of bad) expect(opSchemaError(o)).not.toBeNull()
    expect(opSchemaError({ k: 'attach.remove', id: good.id, card })).toBeNull()
    expect(opSchemaError({ k: 'attach.remove', id: good.id })).not.toBeNull()
  })

  it('a file on a card: first write wins, a removal is for good, and both change the card version', async () => {
    const o = new Peer('owner')
    const b = newBoard(o)
    const card = addCard(o, b, 'c')
    const v0 = o.view(b).cards.get(card)!.version
    const op = (await attachOp(card, bytes(5000), 'report.pdf')) as Extract<BoardOp, { k: 'attach.add' }>
    o.op(b, op)
    o.op(b, { ...op, name: 'renamed.pdf' }) // same id again: ignored
    const v = o.view(b)
    expect(atts(v, card).map((a) => a.name)).toEqual(['report.pdf'])
    const at = atts(v, card)[0]!
    expect(at).toMatchObject({ n: 1, size: 5000, by: o.pub, root: rootOf(fromB64url(op.hashes)) })
    expect(v.blobs.get(at.root)?.id).toBe(op.id)
    expect(v.cards.get(card)!.version).not.toBe(v0)

    const v1 = v.cards.get(card)!.version
    o.op(b, { k: 'attach.remove', id: op.id, card: newEntityId() }) // wrong card: no effect
    expect(atts(o.view(b), card)).toHaveLength(1)
    o.op(b, { k: 'attach.remove', id: op.id, card })
    const after = o.view(b)
    expect(atts(after, card)).toEqual([])
    expect(after.blobs.size).toBe(0)
    expect(after.cards.get(card)!.version).not.toBe(v1)
  })

  it('viewers cannot attach or remove; editors can, everywhere alike', async () => {
    const o = new Peer('owner')
    const e = new Peer('editor')
    const w = new Peer('viewer')
    const b = newBoard(o)
    o.write([setRoleItem(o.view(b), o.id, e.pub, 'editor')])
    o.write([setRoleItem(o.view(b), o.id, w.pub, 'viewer')])
    const card = addCard(o, b, 'c')
    syncAll(o, e, w)
    w.op(b, await attachOp(card, bytes(10), 'from-viewer'))
    e.op(b, await attachOp(card, bytes(10), 'from-editor'))
    syncAll(o, e, w)
    for (const p of [o, e, w]) expect(atts(p.view(b), card).map((a) => a.name)).toEqual(['from-editor'])
    const id = atts(o.view(b), card)[0]!.id
    w.op(b, { k: 'attach.remove', id, card })
    syncAll(o, e, w)
    expect(atts(o.view(b), card)).toHaveLength(1)
  })

  it('moving a card carries its files with the same key and pieces', async () => {
    const o = new Peer('owner')
    const src = newBoard(o, 'S')
    const dst = newBoard(o, 'D')
    const card = addCard(o, src, 'with files')
    o.op(src, await attachOp(card, bytes(PIECE_SIZE * 3), 'video.mp4'))
    const before = atts(o.view(src), card)[0]!
    const { items, mapping } = moveCardsToBoardItems(o.view(src), o.view(dst), [card], o.view(dst).columns[0]!.id, 0)
    o.write(items)
    const moved = atts(o.view(dst), mapping.get(card)!)
    expect(moved).toHaveLength(1)
    expect(moved[0]).toMatchObject({ name: 'video.mp4', root: before.root, key: before.key, n: 3 })
    expect(moved[0]!.id).not.toBe(before.id)
    expect(o.view(dst).blobs.has(before.root)).toBe(true)
  })
})
