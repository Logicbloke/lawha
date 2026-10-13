import { createEnvelope, msgId } from './envelope'
import { schemaError } from './validate'
import type { LawhaDb } from './db'
import type { AclContent, EnvelopeType, Head, Identity, OpContent, StoredMessage } from './types'

export interface BuildCtx {
  board: string
  author: string
  dev: string
  seq: number
  /** envelopes already written earlier in this batch */
  prior: StoredMessage[]
}

/** One envelope to append. `build` runs synchronously inside the write transaction. */
export interface AppendItem {
  board: string
  type: EnvelopeType
  /** highest-clock envelope seen; later items of the same board chain onto earlier ones */
  dep: string | null
  build: (ctx: BuildCtx) => AclContent | OpContent
}

/**
 * Sign and store several envelopes atomically. Head read, encryption, signing
 * and writes all happen in one readwrite transaction (noble's crypto is
 * synchronous, so nothing awaits outside IndexedDB), so two writers on this
 * device can never fork its chain, and a cross-board move lands entirely or
 * not at all.
 */
export async function appendBatch(
  db: LawhaDb,
  identity: Identity,
  dev: string,
  items: AppendItem[],
  ts: number = Date.now(),
): Promise<StoredMessage[]> {
  const tx = db.transaction(['messages', 'heads'], 'readwrite')
  const heads = tx.objectStore('heads')
  const messages = tx.objectStore('messages')
  const out: StoredMessage[] = []
  const lastInBatch = new Map<string, StoredMessage>()
  try {
    for (const item of items) {
      const head = await heads.get([item.board, identity.pub, dev])
      const seq = head ? head.seq + 1 : 1
      const content = item.build({ board: item.board, author: identity.pub, dev, seq, prior: out })
      const earlier = lastInBatch.get(item.board)
      const env = createEnvelope(
        identity,
        { board: item.board, dev, head: head ? { seq: head.seq, id: head.id } : null, dep: earlier?.id ?? item.dep },
        item.type,
        content,
        ts,
      )
      // An envelope peers would reject wedges our own chain at this seq for
      // every member — hold local output to the receive rules.
      const err = schemaError(env)
      if (err) throw new Error(`invalid envelope: ${err}`)
      const stored: StoredMessage = { ...env, id: msgId(env), receivedAt: ts }
      await messages.put(stored)
      const next: Head = { board: item.board, author: identity.pub, dev, seq, id: stored.id }
      await heads.put(next)
      out.push(stored)
      lastInBatch.set(item.board, stored)
    }
    await tx.done
  } catch (e) {
    tx.done.catch(() => undefined)
    try {
      tx.abort()
    } catch {
      // already finished
    }
    throw e
  }
  return out
}
