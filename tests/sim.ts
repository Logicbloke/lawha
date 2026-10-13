import 'fake-indexeddb/auto'
import { randomBytes } from '@noble/hashes/utils.js'
import { toB64url } from '../src/core/b64'
import { createEnvelope, msgId } from '../src/core/envelope'
import { generateIdentity } from '../src/core/identity'
import { computeBoard, type BoardOp, type BoardView, type DecryptCache } from '../src/core/board'
import { opItem } from '../src/core/actions'
import { schemaError } from '../src/core/validate'
import type { AppendItem } from '../src/core/log'
import type { ForkRecord, Identity, StoredMessage } from '../src/core/types'

/**
 * An in-memory peer: its own identity, device and envelope set. Writes are
 * built from its *own* view, so tests can stage concurrency precisely by
 * choosing when peers sync.
 */
export class Peer {
  readonly id: Identity
  readonly dev: string
  readonly msgs = new Map<string, StoredMessage>()
  forks: ForkRecord[] = []
  private cache: DecryptCache = new Map()
  ts = 1000

  constructor(public readonly label: string, id?: Identity, dev?: string) {
    this.id = id ?? generateIdentity()
    this.dev = dev ?? toB64url(randomBytes(16))
  }

  get pub(): string {
    return this.id.pub
  }

  view(board: string): BoardView {
    return computeBoard(board, [...this.msgs.values()], this.forks, this.id, this.cache)
  }

  /** Same signing path as log.appendBatch, without IndexedDB. */
  write(items: AppendItem[]): StoredMessage[] {
    const out: StoredMessage[] = []
    const last = new Map<string, StoredMessage>()
    for (const item of items) {
      let head: StoredMessage | undefined
      for (const m of this.msgs.values()) {
        if (m.board === item.board && m.author === this.pub && m.dev === this.dev && (!head || m.seq > head.seq)) head = m
      }
      const seq = head ? head.seq + 1 : 1
      const content = item.build({ board: item.board, author: this.pub, dev: this.dev, seq, prior: out })
      const env = createEnvelope(
        this.id,
        { board: item.board, dev: this.dev, head: head ? { seq: head.seq, id: head.id } : null, dep: last.get(item.board)?.id ?? item.dep },
        item.type,
        content,
        this.ts++,
      )
      const err = schemaError(env)
      if (err) throw new Error(err)
      const stored = { ...env, id: msgId(env), receivedAt: env.ts }
      this.msgs.set(stored.id, stored)
      out.push(stored)
      last.set(item.board, stored)
    }
    return out
  }

  op(board: string, op: BoardOp): StoredMessage {
    return this.write([opItem(this.view(board), op)])[0]!
  }

  /** Pull everything `other` has (one-way). */
  pull(other: Peer): void {
    for (const [id, m] of other.msgs) if (!this.msgs.has(id)) this.msgs.set(id, m)
  }

  /** Store an envelope crafted elsewhere. */
  inject(m: StoredMessage): void {
    this.msgs.set(m.id, m)
  }
}

export function syncAll(...peers: Peer[]): void {
  for (const a of peers) for (const b of peers) if (a !== b) a.pull(b)
}

export function cardTitles(view: BoardView): string[] {
  return [...view.cards.values()].filter((c) => c.movedTo === null && !c.archived).map((c) => c.title).sort()
}

export function roleOfView(view: BoardView, pub: string): string {
  return view.members.find((m) => m.pub === pub)?.role ?? 'none'
}

let counter = 0
export function uniqueDbName(): string {
  return `test-${Date.now()}-${counter++}`
}
