import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type {
  BlobRecord,
  BoardRecord,
  ContactRecord,
  DeviceRecord,
  ForkRecord,
  Head,
  IdentityRecord,
  SessionRecord,
  StoredMessage,
} from './types'

type ChainSeqKey = [string, string, string, number]
type ChainKey = [string, string, string]

export interface LawhaSchema extends DBSchema {
  messages: {
    key: string
    value: StoredMessage
    indexes: { 'by-chain-seq': ChainSeqKey; 'by-board': string }
  }
  heads: { key: ChainKey; value: Head; indexes: { 'by-board': string } }
  /** chain-valid but out of order: waits for the gap to fill */
  pending: {
    key: string
    value: StoredMessage
    indexes: { 'by-chain-seq': ChainSeqKey; 'by-board': string; 'by-received': number }
  }
  /** from authors the board's ACL has never named; promoted when it does */
  orphans: {
    key: string
    value: StoredMessage
    indexes: { 'by-board': string; 'by-received': number }
  }
  forks: { key: ChainKey; value: ForkRecord; indexes: { 'by-board': string } }
  identity: { key: string; value: IdentityRecord }
  session: { key: string; value: SessionRecord }
  device: { key: string; value: DeviceRecord }
  boards: { key: string; value: BoardRecord }
  contacts: { key: string; value: ContactRecord }
  /** attachments held here: which pieces, by root */
  blobs: { key: string; value: BlobRecord }
  /** sealed attachment pieces, keyed [root, index]; never loaded with the boards */
  pieces: { key: [string, number]; value: Uint8Array }
}

export type LawhaDb = IDBPDatabase<LawhaSchema>

export const PENDING_CAP = 500
export const ORPHAN_CAP = 2000

/**
 * `onTerminated` fires when the browser closes the connection out from under
 * us — WebKit (every browser on iOS) does this when the tab is backgrounded or
 * under memory pressure. The handle is dead afterwards, so the caller must
 * drop it and reopen. See `withDb` in state/store.ts.
 */
export function openLawhaDb(name = 'lawha', onTerminated?: () => void): Promise<LawhaDb> {
  return openDB<LawhaSchema>(name, 2, {
    terminated: onTerminated,
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const messages = db.createObjectStore('messages', { keyPath: 'id' })
        messages.createIndex('by-chain-seq', ['board', 'author', 'dev', 'seq'], { unique: true })
        messages.createIndex('by-board', 'board')

        const heads = db.createObjectStore('heads', { keyPath: ['board', 'author', 'dev'] })
        heads.createIndex('by-board', 'board')

        const pending = db.createObjectStore('pending', { keyPath: 'id' })
        pending.createIndex('by-chain-seq', ['board', 'author', 'dev', 'seq'])
        pending.createIndex('by-board', 'board')
        pending.createIndex('by-received', 'receivedAt')

        const orphans = db.createObjectStore('orphans', { keyPath: 'id' })
        orphans.createIndex('by-board', 'board')
        orphans.createIndex('by-received', 'receivedAt')

        const forks = db.createObjectStore('forks', { keyPath: ['board', 'author', 'dev'] })
        forks.createIndex('by-board', 'board')

        db.createObjectStore('identity', { keyPath: 'id' })
        db.createObjectStore('session', { keyPath: 'id' })
        db.createObjectStore('device', { keyPath: 'id' })
        db.createObjectStore('boards', { keyPath: 'id' })
        db.createObjectStore('contacts', { keyPath: 'pub' })
      }
      if (oldVersion < 2) {
        db.createObjectStore('blobs', { keyPath: 'root' })
        db.createObjectStore('pieces')
      }
    },
  })
}

// ---- logs ----

export function getHead(
  db: LawhaDb,
  board: string,
  author: string,
  dev: string,
): Promise<Head | undefined> {
  return db.get('heads', [board, author, dev])
}

export function getBoardHeads(db: LawhaDb, board: string): Promise<Head[]> {
  return db.getAllFromIndex('heads', 'by-board', board)
}

export function getMessage(db: LawhaDb, id: string): Promise<StoredMessage | undefined> {
  return db.get('messages', id)
}

export function getBoardMessages(db: LawhaDb, board: string): Promise<StoredMessage[]> {
  return db.getAllFromIndex('messages', 'by-board', board)
}

export function getMessageAt(
  db: LawhaDb,
  board: string,
  author: string,
  dev: string,
  seq: number,
): Promise<StoredMessage | undefined> {
  return db.getFromIndex('messages', 'by-chain-seq', [board, author, dev, seq])
}

export function getChainRange(
  db: LawhaDb,
  board: string,
  author: string,
  dev: string,
  fromSeq: number,
  toSeq: number,
): Promise<StoredMessage[]> {
  return db.getAllFromIndex(
    'messages',
    'by-chain-seq',
    IDBKeyRange.bound([board, author, dev, fromSeq], [board, author, dev, toSeq]),
  )
}

// ---- pending (out-of-order) buffer ----

export function getPendingAt(
  db: LawhaDb,
  board: string,
  author: string,
  dev: string,
  seq: number,
): Promise<StoredMessage | undefined> {
  return db.getFromIndex('pending', 'by-chain-seq', [board, author, dev, seq])
}

/** Insert into a capped store, evicting the oldest of the same board past the cap. */
async function putCapped(
  db: LawhaDb,
  store: 'pending' | 'orphans',
  record: StoredMessage,
  cap: number,
): Promise<void> {
  const tx = db.transaction(store, 'readwrite')
  await tx.store.put(record)
  const ids = await tx.store.index('by-board').getAllKeys(record.board)
  if (ids.length > cap) {
    const rows = await Promise.all(ids.map((id) => tx.store.get(id)))
    const oldest = rows
      .filter((r): r is StoredMessage => !!r)
      .sort((a, b) => a.receivedAt - b.receivedAt)
      .slice(0, ids.length - cap)
    for (const r of oldest) await tx.store.delete(r.id)
  }
  await tx.done
}

export function putPending(db: LawhaDb, record: StoredMessage): Promise<void> {
  return putCapped(db, 'pending', record, PENDING_CAP)
}

export function deletePending(db: LawhaDb, id: string): Promise<void> {
  return db.delete('pending', id)
}

// ---- orphans ----

export function putOrphan(db: LawhaDb, record: StoredMessage): Promise<void> {
  return putCapped(db, 'orphans', record, ORPHAN_CAP)
}

export function getBoardOrphans(db: LawhaDb, board: string): Promise<StoredMessage[]> {
  return db.getAllFromIndex('orphans', 'by-board', board)
}

export function deleteOrphan(db: LawhaDb, id: string): Promise<void> {
  return db.delete('orphans', id)
}

// ---- forks ----

export function getBoardForks(db: LawhaDb, board: string): Promise<ForkRecord[]> {
  return db.getAllFromIndex('forks', 'by-board', board)
}

/** Keep the lowest fork seq per chain: everything from it on is invalid. */
export async function putFork(db: LawhaDb, fork: ForkRecord): Promise<boolean> {
  const tx = db.transaction('forks', 'readwrite')
  const existing = await tx.store.get([fork.board, fork.author, fork.dev])
  const isNew = !existing || fork.seq < existing.seq
  if (isNew) await tx.store.put(fork)
  await tx.done
  return isNew
}

// ---- identity / session / device ----

export function getIdentityRecord(db: LawhaDb): Promise<IdentityRecord | undefined> {
  return db.get('identity', 'self')
}

export function putIdentityRecord(db: LawhaDb, record: IdentityRecord): Promise<string> {
  return db.put('identity', record)
}

export function getSessionRecord(db: LawhaDb): Promise<SessionRecord | undefined> {
  return db.get('session', 'self')
}

export function putSessionRecord(db: LawhaDb, record: SessionRecord): Promise<string> {
  return db.put('session', record)
}

export function deleteSessionRecord(db: LawhaDb): Promise<void> {
  return db.delete('session', 'self')
}

export function getDeviceRecord(db: LawhaDb): Promise<DeviceRecord | undefined> {
  return db.get('device', 'self')
}

export function putDeviceRecord(db: LawhaDb, record: DeviceRecord): Promise<string> {
  return db.put('device', record)
}

// ---- boards / contacts ----

export function getBoardRecords(db: LawhaDb): Promise<BoardRecord[]> {
  return db.getAll('boards')
}

export function getBoardRecord(db: LawhaDb, id: string): Promise<BoardRecord | undefined> {
  return db.get('boards', id)
}

export function putBoardRecord(db: LawhaDb, record: BoardRecord): Promise<string> {
  return db.put('boards', record)
}

export function getContacts(db: LawhaDb): Promise<ContactRecord[]> {
  return db.getAll('contacts')
}

export function putContact(db: LawhaDb, record: ContactRecord): Promise<string> {
  return db.put('contacts', record)
}

export function deleteContact(db: LawhaDb, pub: string): Promise<void> {
  return db.delete('contacts', pub)
}
