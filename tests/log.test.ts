import { describe, expect, it } from 'vitest'
import { Peer, uniqueDbName } from './sim'
import { openLawhaDb, getBoardForks, getBoardMessages, getHead } from '../src/core/db'
import { appendBatch } from '../src/core/log'
import { createBoardItems, opItem } from '../src/core/actions'
import { computeBoard } from '../src/core/board'
import { receiveEnvelope, verifyForkProof } from '../src/core/validate'
import { createEnvelope, toWire } from '../src/core/envelope'
import { exportIdentity, generateIdentity, importIdentity } from '../src/core/identity'
import { randomBytes } from '@noble/hashes/utils.js'
import { toB64url } from '../src/core/b64'

const dev = () => toB64url(randomBytes(16))

describe('local log', () => {
  it('appends a whole batch atomically, or nothing', async () => {
    const db = await openLawhaDb(uniqueDbName())
    const me = generateIdentity()
    const d = dev()
    const { id, items } = createBoardItems(me, { kind: 'board', ws: null, name: 'B', myName: 'me', columns: ['A'] })
    const written = await appendBatch(db, me, d, items)
    expect(written.map((m) => m.seq)).toEqual([1, 2, 3, 4])
    const view = computeBoard(id, await getBoardMessages(db, id), [], me)
    const bad = { ...opItem(view, { k: 'profile.set', name: 'x' }), build: () => ({ acl: [], epoch: 'x', n: 'y', box: 'z' }) }
    await expect(appendBatch(db, me, d, [opItem(view, { k: 'profile.set', name: 'ok' }), bad])).rejects.toThrow()
    expect((await getHead(db, id, me.pub, d))!.seq).toBe(4)
    expect(await getBoardMessages(db, id)).toHaveLength(4)
  })
})

describe('receive pipeline', () => {
  it('accepts in order, buffers gaps, drains them, and dedupes', async () => {
    const db = await openLawhaDb(uniqueDbName())
    const o = new Peer('o')
    const { id, items } = createBoardItems(o.id, { kind: 'board', ws: null, name: 'B', myName: '', columns: ['A', 'B'] })
    const msgs = o.write(items)
    const r3 = await receiveEnvelope(db, toWire(msgs[2]!))
    expect(r3.status).toBe('pending')
    expect(r3.gap).toMatchObject({ from: 1, to: 2 })
    expect((await receiveEnvelope(db, toWire(msgs[0]!))).status).toBe('accepted')
    const r2 = await receiveEnvelope(db, toWire(msgs[1]!))
    expect(r2.accepted.map((m) => m.seq)).toEqual([2, 3])
    expect((await receiveEnvelope(db, toWire(msgs[1]!))).status).toBe('duplicate')
    expect((await getHead(db, id, o.pub, o.dev))!.seq).toBe(3)
  })

  it('rejects tampering and malformed envelopes', async () => {
    const db = await openLawhaDb(uniqueDbName())
    const o = new Peer('o')
    const { items } = createBoardItems(o.id, { kind: 'board', ws: null, name: 'B', myName: '', columns: [] })
    const [g] = o.write(items)
    const wire = toWire(g!)
    expect((await receiveEnvelope(db, { ...wire, ts: wire.ts + 1 })).reason).toBe('bad signature')
    expect((await receiveEnvelope(db, { ...wire, extra: 1 } as never)).status).toBe('invalid')
    expect((await receiveEnvelope(db, { ...wire, dev: 'short' })).status).toBe('invalid')
  })

  it('turns an equivocation into a verifiable fork proof', async () => {
    const db = await openLawhaDb(uniqueDbName())
    const o = new Peer('o')
    const { id, items } = createBoardItems(o.id, { kind: 'board', ws: null, name: 'B', myName: '', columns: ['A'] })
    const [g, a] = o.write(items)
    await receiveEnvelope(db, toWire(g!))
    await receiveEnvelope(db, toWire(a!))
    const twin = createEnvelope(o.id, { board: id, dev: o.dev, head: { seq: 1, id: g!.id }, dep: g!.id }, 'op', a!.content, a!.ts + 5)
    const r = await receiveEnvelope(db, twin)
    expect(r.status).toBe('forked')
    expect(verifyForkProof(r.fork)).not.toBeNull()
    expect(await getBoardForks(db, id)).toHaveLength(1)
  })
})

describe('concurrent delivery', () => {
  it('the same envelope from two peers at once is a duplicate, never a fork', async () => {
    const db = await openLawhaDb(uniqueDbName())
    const o = new Peer('o')
    const { id, items } = createBoardItems(o.id, { kind: 'board', ws: null, name: 'B', myName: '', columns: ['A', 'B', 'C'] })
    const msgs = o.write(items).map(toWire)
    await Promise.all([
      (async () => { for (const m of msgs) await receiveEnvelope(db, m) })(),
      (async () => { for (const m of msgs) await receiveEnvelope(db, m) })(),
    ])
    expect(await getBoardForks(db, id)).toHaveLength(0)
    expect(await getBoardMessages(db, id)).toHaveLength(msgs.length)
  })
})

describe('identity', () => {
  it('round-trips a backup and accepts Shabaka backups of the same key', () => {
    const me = generateIdentity()
    const backup = exportIdentity(me)
    expect(backup.startsWith('lawha-key-v1:')).toBe(true)
    expect(importIdentity(backup).pub).toBe(me.pub)
    expect(importIdentity(backup.replace('lawha-key-v1:', 'shabaka-key-v1:')).pub).toBe(me.pub)
    expect(() => importIdentity('nope')).toThrow()
  })
})
