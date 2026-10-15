import { fromB64url } from './b64'
import { pieceMatches, sealedPieceLen } from './blobcrypto'
import type { LawhaDb } from './db'
import { Emitter } from './events'
import type { BlobRecord } from './types'

/**
 * Attachment bytes: where they are kept (BlobStore) and how they are fetched
 * (Swarm). Pieces stay sealed at rest, as they travel. Any member who holds
 * a piece serves it to the board's other members (sync.ts, `bl` and
 * `piece`), so a file stays available while anyone who fetched it is online,
 * not only its uploader. None of this is part of a board's derived state:
 * whether a file's bytes are here is local, like a cache.
 */

export const bitBytes = (n: number) => Math.ceil(n / 8)
export const bitGet = (bits: Uint8Array, i: number) => ((bits[i >> 3] ?? 0) & (1 << (i & 7))) !== 0
const bitSet = (bits: Uint8Array, i: number) => {
  bits[i >> 3] = (bits[i >> 3] ?? 0) | (1 << (i & 7))
}

const pieceRange = (root: string) => IDBKeyRange.bound([root, 0], [root, Number.MAX_SAFE_INTEGER])

export class BlobStore {
  /** records read or written this session (null: not held) */
  private cache = new Map<string, BlobRecord | null>()

  constructor(
    private getDb: () => LawhaDb,
    private now: () => number = () => Date.now(),
  ) {}

  private get db(): LawhaDb {
    return this.getDb()
  }

  async record(root: string): Promise<BlobRecord | null> {
    const hit = this.cache.get(root)
    if (hit !== undefined) return hit
    const rec = (await this.db.get('blobs', root)) ?? null
    this.cache.set(root, rec)
    return rec
  }

  async complete(root: string): Promise<boolean> {
    const rec = await this.record(root)
    return !!rec && rec.count === rec.n
  }

  getPiece(root: string, i: number): Promise<Uint8Array | undefined> {
    return this.db.get('pieces', [root, i])
  }

  /** Keep checked pieces (index, sealed bytes) of the file `root` of `n` pieces. */
  async put(root: string, n: number, pieces: Array<[number, Uint8Array]>, pinned = false): Promise<BlobRecord> {
    const tx = this.db.transaction(['blobs', 'pieces'], 'readwrite')
    const blobs = tx.objectStore('blobs')
    const store = tx.objectStore('pieces')
    const old = await blobs.get(root)
    const rec: BlobRecord =
      old && old.n === n
        ? old
        : { root, n, got: new Uint8Array(bitBytes(n)), count: 0, bytes: 0, pinned: 0, usedAt: 0 }
    for (const [i, data] of pieces) {
      if (i < 0 || i >= n || bitGet(rec.got, i)) continue
      await store.put(data, [root, i])
      bitSet(rec.got, i)
      rec.count++
      rec.bytes += data.length
    }
    if (pinned) rec.pinned = 1
    rec.usedAt = this.now()
    await blobs.put(rec)
    await tx.done
    this.cache.set(root, rec)
    return rec
  }

  /** Every sealed piece in order, or null while some are missing. */
  async read(root: string): Promise<Uint8Array[] | null> {
    const rec = await this.record(root)
    if (!rec || rec.count !== rec.n) return null
    const pieces = await this.db.getAll('pieces', pieceRange(root))
    if (pieces.length !== rec.n) return null
    rec.usedAt = this.now()
    await this.db.put('blobs', rec)
    return pieces
  }

  async remove(root: string): Promise<void> {
    const tx = this.db.transaction(['blobs', 'pieces'], 'readwrite')
    await tx.objectStore('pieces').delete(pieceRange(root))
    await tx.objectStore('blobs').delete(root)
    await tx.done
    this.cache.set(root, null)
  }

  all(): Promise<BlobRecord[]> {
    return this.db.getAll('blobs')
  }

  /**
   * Drop files no live attachment names (once `grace` ms unused: an upload
   * is stored just before its op), then the least recently used unpinned
   * ones until what is left fits in `budget` bytes. Returns what went.
   */
  async gc(live: (root: string) => boolean, budget: number, grace: number): Promise<string[]> {
    const now = this.now()
    const gone: string[] = []
    const kept: BlobRecord[] = []
    for (const rec of await this.all()) {
      if (!live(rec.root) && now - rec.usedAt > grace) gone.push(rec.root)
      else kept.push(rec)
    }
    let total = kept.reduce((s, r) => s + r.bytes, 0)
    for (const rec of kept.filter((r) => !r.pinned).sort((a, b) => a.usedAt - b.usedAt)) {
      if (total <= budget) break
      gone.push(rec.root)
      total -= rec.bytes
    }
    for (const root of gone) await this.remove(root)
    return gone
  }
}

// ---- fetching ----

/** One attachment as the fetcher needs it (an Attachment fits). */
export interface BlobRef {
  root: string
  n: number
  size: number
  ps: number
  hashes: string
}

export type BlobMsg =
  | { step: 'q'; r: string }
  | { step: 'h'; r: string; bits: string }
  | { step: 'get'; r: string; i: number[] }

export interface SwarmIo {
  /** sessions of this board to fetch from: authenticated, serving us, taking `bl`; one per install */
  sources(board: string): string[]
  send(key: string, msg: BlobMsg): void
  /** is this still a live attachment of this board (else stop fetching it) */
  live(board: string, root: string): boolean
  now(): number
}

export interface BlobStatus {
  root: string
  got: number
  n: number
  done: boolean
  /** connected peers known to hold some of it */
  holders: number
  /** when we last asked who holds it (0: not yet) */
  askedAt: number
}

export interface SwarmEvents {
  status: BlobStatus
}

/** pieces asked of one peer at a time, and of all peers for one file */
export const PER_PEER = 2
export const PER_FILE = 6
/** a piece not here by then is asked of someone else */
export const PIECE_TIMEOUT_MS = 20_000
/** with no one known to hold what is missing, ask around again after this */
export const REASK_MS = 15_000

interface Fetch {
  board: string
  ref: BlobRef
  hashes: Uint8Array
  ready: boolean
  missing: Set<number>
  holders: Map<string, Uint8Array>
  inflight: Map<number, { key: string; at: number }>
  askedAt: number
  done: Promise<void>
  resolve: () => void
}

/**
 * Fetches files from the board's members: ask who holds which pieces (`q` →
 * `h` with a bitfield), then pull missing pieces a few at a time from
 * whoever has them, each checked against the hashes in the op before it is
 * stored. A peer that sends a wrong piece stops being asked for that file.
 */
export class Swarm {
  readonly events = new Emitter<SwarmEvents>()
  private fetches = new Map<string, Fetch>()
  private done = new Set<string>()
  private load = new Map<string, number>()
  private tasks = new Set<Promise<unknown>>()

  constructor(
    private io: SwarmIo,
    private store: BlobStore,
  ) {}

  /** Fetch the file from members of `board`; resolves once every piece is here. */
  want(board: string, ref: BlobRef): Promise<void> {
    const f = this.fetches.get(ref.root)
    if (f) return f.done
    if (this.done.has(ref.root)) return Promise.resolve()
    return this.start(board, ref).done
  }

  /** We hold all of it (our own upload). */
  markComplete(root: string): void {
    this.done.add(root)
  }

  isWanted(root: string): boolean {
    return this.fetches.has(root)
  }

  status(root: string): BlobStatus | null {
    const f = this.fetches.get(root)
    if (f) return this.statusOf(f)
    return null
  }

  private statusOf(f: Fetch): BlobStatus {
    return {
      root: f.ref.root,
      got: f.ref.n - f.missing.size,
      n: f.ref.n,
      done: f.ready && f.missing.size === 0,
      holders: f.holders.size,
      askedAt: f.askedAt,
    }
  }

  private emit(f: Fetch): void {
    this.events.emit('status', this.statusOf(f))
  }

  private start(board: string, ref: BlobRef): Fetch {
    let resolve!: () => void
    const done = new Promise<void>((r) => (resolve = r))
    const f: Fetch = {
      board,
      ref,
      hashes: fromB64url(ref.hashes),
      ready: false,
      missing: new Set(),
      holders: new Map(),
      inflight: new Map(),
      askedAt: 0,
      done,
      resolve,
    }
    this.fetches.set(ref.root, f)
    const t = this.store
      .record(ref.root)
      .then((rec) => {
        if (this.fetches.get(ref.root) !== f) return
        for (let i = 0; i < ref.n; i++) if (!rec || rec.n !== ref.n || !bitGet(rec.got, i)) f.missing.add(i)
        f.ready = true
        if (f.missing.size === 0) return this.finish(f)
        this.ask(f)
        this.emit(f)
      })
      .catch(() => {
        // the database went away (iOS): the next want() starts over
        if (this.fetches.get(ref.root) === f) this.fetches.delete(ref.root)
      })
    this.tasks.add(t)
    void t.finally(() => this.tasks.delete(t))
    return f
  }

  /** Resolves once no store read started by want() is pending (tests). */
  async idle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks])
  }

  private finish(f: Fetch): void {
    for (const { key } of f.inflight.values()) this.release(key)
    f.inflight.clear()
    this.fetches.delete(f.ref.root)
    this.done.add(f.ref.root)
    this.emit(f)
    f.resolve()
  }

  /** Stop fetching (the attachment was removed). Waiters are left pending. */
  cancel(root: string): void {
    const f = this.fetches.get(root)
    if (!f) return
    for (const { key } of f.inflight.values()) this.release(key)
    this.fetches.delete(root)
  }

  private ask(f: Fetch): void {
    f.askedAt = this.io.now()
    for (const key of this.io.sources(f.board)) this.io.send(key, { step: 'q', r: f.ref.root })
  }

  private release(key: string): void {
    const n = (this.load.get(key) ?? 1) - 1
    if (n > 0) this.load.set(key, n)
    else this.load.delete(key)
  }

  private schedule(f: Fetch): void {
    if (!f.ready || f.holders.size === 0) return
    const asks = new Map<string, number[]>()
    for (const i of f.missing) {
      if (f.inflight.size >= PER_FILE) break
      if (f.inflight.has(i)) continue
      let best: string | null = null
      let bestLoad = PER_PEER
      for (const [key, bits] of f.holders) {
        const l = this.load.get(key) ?? 0
        if (l < bestLoad && bitGet(bits, i)) [best, bestLoad] = [key, l]
      }
      if (best === null) continue
      f.inflight.set(i, { key: best, at: this.io.now() })
      this.load.set(best, bestLoad + 1)
      asks.set(best, [...(asks.get(best) ?? []), i])
    }
    for (const [key, i] of asks) this.io.send(key, { step: 'get', r: f.ref.root, i })
  }

  /** A peer said which pieces of `root` it holds. */
  onHave(key: string, board: string, root: string, bits: string): void {
    const f = this.fetches.get(root)
    if (!f || f.board !== board) return
    let field: Uint8Array
    try {
      field = fromB64url(bits)
    } catch {
      return
    }
    if (field.length !== bitBytes(f.ref.n)) return
    f.holders.set(key, field)
    this.schedule(f)
    this.emit(f)
  }

  /**
   * A piece arrived. 'bad' when it is not what was asked for (wrong length or
   * hash): the caller holds that against the peer.
   */
  async onPiece(key: string, board: string, root: string, i: number, data: Uint8Array): Promise<'ok' | 'bad' | 'stale'> {
    const f = this.fetches.get(root)
    if (!f || f.board !== board) return 'stale'
    const req = f.inflight.get(i)
    if (!req || req.key !== key) return 'stale'
    f.inflight.delete(i)
    this.release(key)
    if (data.length !== sealedPieceLen(f.ref.size, f.ref.ps, i) || !pieceMatches(f.hashes, i, data)) {
      f.holders.delete(key)
      this.schedule(f)
      this.emit(f)
      return 'bad'
    }
    f.missing.delete(i)
    try {
      await this.store.put(root, f.ref.n, [[i, data]])
    } catch (e) {
      // out of space: leave it missing, it is asked for again later
      f.missing.add(i)
      throw e
    }
    if (this.fetches.get(root) !== f) return 'ok'
    if (f.missing.size === 0) this.finish(f)
    else {
      this.schedule(f)
      this.emit(f)
    }
    return 'ok'
  }

  /** New sessions to fetch from on `board`: ask them about what is still missing. */
  onSources(board: string): void {
    for (const f of this.fetches.values()) if (f.board === board && f.ready) this.ask(f)
  }

  onPeerGone(key: string): void {
    this.load.delete(key)
    for (const f of this.fetches.values()) {
      const had = f.holders.delete(key)
      let lost = false
      for (const [i, req] of f.inflight) {
        if (req.key !== key) continue
        f.inflight.delete(i)
        lost = true
      }
      if (lost) this.schedule(f)
      if (had || lost) this.emit(f)
    }
  }

  /** Every few seconds: give up on slow pieces, ask around again, drop removed files. */
  tick(): void {
    const now = this.io.now()
    for (const f of [...this.fetches.values()]) {
      if (!this.io.live(f.board, f.ref.root)) {
        this.cancel(f.ref.root)
        continue
      }
      if (!f.ready) continue
      let changed = false
      for (const [i, req] of f.inflight) {
        if (now - req.at < PIECE_TIMEOUT_MS) continue
        f.inflight.delete(i)
        this.release(req.key)
        // slow or gone quiet: it is asked again once it says what it has
        f.holders.delete(req.key)
        changed = true
      }
      const held = [...f.missing].some((i) => [...f.holders.values()].some((bits) => bitGet(bits, i)))
      if (!held && now - f.askedAt >= REASK_MS) this.ask(f)
      if (changed) this.schedule(f)
      this.emit(f)
    }
  }
}
