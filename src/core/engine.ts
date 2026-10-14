import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { fromB64url, toB64url, utf8 } from './b64'
import { boardIdFor } from './acl'
import { rotateItem } from './actions'
import { computeBoard, netSecret, type AppliedOp, type BoardView, type DecryptCache } from './board'
import { localKey, openLocal, sealLocal } from './boardcrypto'
import {
  deleteOrphan,
  getBoardForks,
  getBoardMessages,
  getBoardOrphans,
  getBoardRecord,
  getBoardRecords,
  putBoardRecord,
  type LawhaDb,
} from './db'
import { Emitter } from './events'
import { appendBatch, type AppendItem } from './log'
import { SyncManager, type SyncHost } from './sync'
import { receiveEnvelope } from './validate'
import {
  RANK,
  type AclContent,
  type BoardKind,
  type BoardRecord,
  type ForkRecord,
  type Identity,
  type StoredMessage,
} from './types'

/**
 * Keeps every followed board folded in memory, writes through the local log,
 * and answers the sync layer's questions (who may connect, who gets served,
 * whose chains to accept). Framework-agnostic: the zustand store and the
 * tests both drive it.
 */

export interface EngineEvents {
  'board-changed': { board: string }
  'boards-changed': Record<string, never>
  /** local writes the network should push */
  'local-append': { msgs: StoredMessage[] }
  /** a board's ACL changed: rooms and gates may need updating */
  'acl-changed': { board: string }
  'peer-authed': { board: string; pub: string; member: boolean }
  /** a remote install connected or left (see sync.installs()) */
  presence: Record<string, never>
  /** someone opened or closed a card of this board (see sync.lookers()) */
  looks: { board: string }
  /**
   * ops written by someone else that this fold applied for the first time
   * (never on load, nor for history from before we joined the board)
   */
  activity: { board: string; before: BoardView; items: AppliedOp[] }
}

export interface RoomSpec {
  board: string
  roomId: string
  password: string
}

interface BoardState {
  record: BoardRecord
  msgs: Map<string, StoredMessage>
  forks: ForkRecord[]
  cache: DecryptCache
  view: BoardView | null
  known: Set<string>
  aclCount: number
  dirty: boolean
}

export interface EngineOptions {
  /** debounce for re-folding after ingest; 0 = synchronous (tests) */
  debounceMs?: number
  /** heal delays (owner, per-admin step); shortened in tests */
  healDelay?: { owner: number; step: number }
  now?: () => number
}

export class Engine {
  readonly events = new Emitter<EngineEvents>()
  readonly sync: SyncManager
  private boards = new Map<string, BoardState>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private healTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private local: Uint8Array
  private opts: Required<EngineOptions>
  private tasks = new Set<Promise<unknown>>()

  constructor(
    private getDb: () => LawhaDb,
    readonly identity: Identity,
    readonly dev: string,
    opts: EngineOptions = {},
  ) {
    this.opts = {
      debounceMs: opts.debounceMs ?? 100,
      healDelay: opts.healDelay ?? { owner: 2000, step: 20000 },
      now: opts.now ?? (() => Date.now()),
    }
    this.local = localKey(identity)
    const host: SyncHost = {
      db: () => this.getDb(),
      identity,
      dev,
      mayConnect: (board, pub) => this.mayConnect(board, pub),
      isMember: (board, pub) => this.isMember(board, pub),
      isKnownAuthor: (board, author) => this.boards.get(board)?.known.has(author) ?? false,
      shareable: (pub) =>
        [...this.boards.values()]
          .filter((st) => !st.record.hidden && this.isMember(st.record.id, pub) && this.mayConnect(st.record.id, pub))
          .map((st) => st.record.id),
      accepts: (board, pub) => {
        const st = this.boards.get(board)
        return !!st && !st.record.hidden && this.mayConnect(board, pub)
      },
      onIngested: (board, msgs) => this.bg(this.ingested(board, msgs)),
      onFork: (board) => this.bg(this.reloadForks(board)),
      onOrphans: (board) => {
        const st = this.boards.get(board)
        if (st) this.bg(this.promoteOrphans(st))
      },
      onPeerAuthed: (board, pub, member) => this.events.emit('peer-authed', { board, pub, member }),
      onPresence: () => this.events.emit('presence', {}),
      onLooks: (board) => this.events.emit('looks', { board }),
      now: () => this.opts.now(),
    }
    this.sync = new SyncManager(host)
    // what we hold or who is on it changed: shared connections may carry more
    this.events.on('acl-changed', () => this.scheduleReoffer())
    this.events.on('boards-changed', () => this.scheduleReoffer())
  }

  private reofferQueued = false
  private scheduleReoffer(): void {
    if (this.reofferQueued) return
    this.reofferQueued = true
    this.bg(
      Promise.resolve().then(() => {
        this.reofferQueued = false
        this.sync.reoffer()
      }),
    )
  }

  private get db(): LawhaDb {
    return this.getDb()
  }

  // ---- loading ----

  async loadAll(): Promise<void> {
    for (const record of await getBoardRecords(this.db)) await this.loadBoard(record)
    this.events.emit('boards-changed', {})
  }

  private async loadBoard(record: BoardRecord): Promise<BoardState> {
    const msgs = await getBoardMessages(this.db, record.id)
    const st: BoardState = {
      record,
      msgs: new Map(msgs.map((m) => [m.id, m])),
      forks: await getBoardForks(this.db, record.id),
      cache: new Map(),
      view: null,
      known: new Set(),
      aclCount: -1,
      dirty: true,
    }
    this.boards.set(record.id, st)
    this.refold(st)
    return st
  }

  // ---- reading ----

  view(board: string): BoardView | null {
    const st = this.boards.get(board)
    if (!st) return null
    if (st.dirty) this.refold(st)
    return st.view
  }

  records(): BoardRecord[] {
    return [...this.boards.values()].map((s) => s.record)
  }

  /** Text sealed under this install's local key (nothing readable at rest). */
  sealText(text: string): string {
    return JSON.stringify(sealLocal(this.local, text))
  }

  openText(sealed: string): string | null {
    try {
      return openLocal(this.local, JSON.parse(sealed) as { n: string; box: string })
    } catch {
      return null
    }
  }

  /** Display name: live from the fold, else the sealed local cache. */
  boardName(board: string): string {
    const st = this.boards.get(board)
    if (!st) return ''
    if (st.view?.name) return st.view.name
    return st.record.nameCache ? (openLocal(this.local, st.record.nameCache) ?? '') : ''
  }

  workspaces(): BoardView[] {
    return [...this.boards.keys()]
      .map((id) => this.view(id))
      .filter((v): v is BoardView => !!v && v.kind === 'workspace' && v.myRole !== 'none')
  }

  /** The workspace a board belongs to: from its genesis once known, else the invite. */
  wsOf(board: string): string | null {
    const st = this.boards.get(board)
    if (!st) return null
    return st.view && st.view.owner !== null ? st.view.ws : st.record.ws
  }

  // ---- gates ----

  isMember(board: string, pub: string): boolean {
    const v = this.view(board)
    return !!v && (v.resolved.roles.get(pub) ?? 'none') !== 'none'
  }

  mayConnect(board: string, pub: string): boolean {
    const ws = this.wsOf(board)
    if (!ws || ws === board) return true
    const w = this.view(ws)
    return !!w && (w.resolved.roles.get(pub) ?? 'none') !== 'none'
  }

  /**
   * Room coordinates for a board. Company boards hide behind the workspace's
   * network secret; without it (not on the roster) there is no room to join.
   */
  roomSpec(board: string): RoomSpec | null {
    const ws = this.wsOf(board)
    const derive = (secret: Uint8Array, label: string) =>
      toB64url(hkdf(sha256, secret, fromB64url(board), utf8(label), 32))
    if (!ws || ws === board) {
      const seed = sha256(concatBytes(utf8('lawha-public-room'), fromB64url(board)))
      return { board, roomId: derive(seed, 'lawha-room-v1'), password: derive(seed, 'lawha-pass-v1') }
    }
    const w = this.view(ws)
    if (!w?.netEpoch) return null
    const secret = netSecret(ws, w.netEpoch.key)
    return { board, roomId: derive(secret, 'lawha-room-v1'), password: derive(secret, 'lawha-pass-v1') }
  }

  // ---- writing ----

  async write(items: AppendItem[]): Promise<StoredMessage[]> {
    const msgs = await appendBatch(this.db, this.identity, this.dev, items, this.opts.now())
    const touched = new Set<string>()
    for (const m of msgs) {
      const st = this.boards.get(m.board) ?? (await this.ensureBoard(m.board, 'board', null))
      st.msgs.set(m.id, m)
      st.dirty = true
      touched.add(m.board)
    }
    for (const b of touched) {
      // push before re-folding: a member we just removed still hears about it
      this.sync.push(b, msgs)
      const st = this.boards.get(b)!
      st.record = { ...st.record, lastWriteAt: this.opts.now() }
      await putBoardRecord(this.db, st.record)
      this.refold(st)
    }
    this.events.emit('local-append', { msgs })
    return msgs
  }

  /** Create a board or workspace; returns its id. */
  async create(
    kind: BoardKind,
    ws: string | null,
    items: { id: string; items: AppendItem[] },
  ): Promise<string> {
    await this.ensureBoard(items.id, kind, ws)
    await this.write(items.items)
    this.events.emit('boards-changed', {})
    return items.id
  }

  /** Follow a board we were invited to (its logs arrive by sync). */
  async follow(board: string, ws: string | null): Promise<void> {
    await this.ensureBoard(board, ws === board ? 'workspace' : 'board', ws)
    this.events.emit('boards-changed', {})
  }

  async setHidden(board: string, hidden: boolean): Promise<void> {
    const st = this.boards.get(board)
    if (!st) return
    st.record = { ...st.record, hidden: hidden ? 1 : 0 }
    await putBoardRecord(this.db, st.record)
    this.events.emit('boards-changed', {})
  }

  private async ensureBoard(board: string, kind: BoardKind, ws: string | null): Promise<BoardState> {
    const existing = this.boards.get(board)
    if (existing) return existing
    const record: BoardRecord = (await getBoardRecord(this.db, board)) ?? {
      id: board,
      kind,
      ws,
      joinedAt: this.opts.now(),
      lastWriteAt: 0,
      nameCache: null,
      hidden: 0,
    }
    await putBoardRecord(this.db, record)
    return this.loadBoard(record)
  }

  // ---- ingest from the network ----

  private async ingested(board: string, msgs: StoredMessage[]): Promise<void> {
    const st = this.boards.get(board)
    if (!st) return
    for (const m of msgs) {
      st.msgs.set(m.id, m)
      // accept the chains these name right away, not after the debounced fold
      if (m.type !== 'acl') continue
      const c = m.content as AclContent
      if (c.act === 'genesis' && boardIdFor(m.author, c.nonce) === board) st.known.add(m.author)
      if (c.act === 'set-role' && st.known.has(m.author)) st.known.add(c.target)
    }
    st.dirty = true
    this.schedule(st)
  }

  private async reloadForks(board: string): Promise<void> {
    const st = this.boards.get(board)
    if (!st) return
    st.forks = await getBoardForks(this.db, board)
    st.dirty = true
    this.schedule(st)
  }

  private schedule(st: BoardState): void {
    if (this.opts.debounceMs === 0) {
      this.refold(st)
      return
    }
    if (this.timers.has(st.record.id)) return
    this.timers.set(
      st.record.id,
      setTimeout(() => {
        this.timers.delete(st.record.id)
        this.refold(st)
      }, this.opts.debounceMs),
    )
  }

  /** Fold, then react to ACL changes: gates, orphans, name cache, heal. */
  private refold(st: BoardState): void {
    const board = st.record.id
    const before = st.view
    const view = computeBoard(board, [...st.msgs.values()], st.forks, this.identity, st.cache)
    st.view = view
    st.dirty = false

    const aclCount = view.resolved.aclOps.length
    const aclChanged = aclCount !== st.aclCount
    st.aclCount = aclCount
    if (aclChanged) {
      st.known = knownAuthors(view)
      this.bg(this.sync.refreshGate(board))
      this.bg(this.promoteOrphans(st))
      this.events.emit('acl-changed', { board })
      // a workspace's roster gates its company boards' rooms
      if (view.kind === 'workspace') {
        for (const other of this.boards.values()) {
          if (other.record.ws === board) this.bg(this.sync.refreshGate(other.record.id))
        }
      }
    }
    this.bg(this.cacheName(st))
    this.maybeHeal(st)
    this.events.emit('board-changed', { board })
    if (before) this.reportActivity(st, before, view)
  }

  private reportActivity(st: BoardState, before: BoardView, view: BoardView): void {
    const seen = new Set(before.ops.map((o) => o.id))
    const me = this.identity.pub
    const items = view.ops.filter((o) => !seen.has(o.id) && o.author !== me && o.ts >= st.record.joinedAt)
    if (items.length > 0) this.events.emit('activity', { board: st.record.id, before, items })
  }

  private async cacheName(st: BoardState): Promise<void> {
    const name = st.view?.name
    const known = !!st.view && st.view.owner !== null
    const kind = known ? st.view!.kind : st.record.kind
    const ws = known ? st.view!.ws : st.record.ws
    const cached = st.record.nameCache ? openLocal(this.local, st.record.nameCache) : null
    if ((!name || name === cached) && kind === st.record.kind && ws === st.record.ws) return
    st.record = {
      ...st.record,
      kind,
      ws,
      nameCache: name ? sealLocal(this.local, name) : st.record.nameCache,
    }
    await putBoardRecord(this.db, st.record)
    this.events.emit('boards-changed', {})
  }

  private async promoteOrphans(st: BoardState): Promise<void> {
    const board = st.record.id
    const orphans = (await getBoardOrphans(this.db, board)).filter((o) => st.known.has(o.author))
    if (orphans.length === 0) return
    orphans.sort((a, b) => a.seq - b.seq)
    const accepted: StoredMessage[] = []
    for (const o of orphans) {
      await deleteOrphan(this.db, o.id)
      const { id: _id, receivedAt, ...env } = o
      const r = await receiveEnvelope(this.db, env, receivedAt)
      accepted.push(...r.accepted)
    }
    if (accepted.length > 0) await this.ingested(board, accepted)
  }

  // ---- key healing ----

  /**
   * When a valid epoch head reaches a non-member (someone left or was removed
   * concurrently) or a member lacks a head (added concurrently with a
   * rotation), an admin rotates. The owner acts at once; admins back off in
   * pub order so concurrent heals rarely collide (and if they do, the result
   * is still consistent).
   */
  private maybeHeal(st: BoardState): void {
    const board = st.record.id
    const v = st.view
    const timer = this.healTimers.get(board)
    if (!v || !v.needsHeal || RANK[v.myRole] < RANK.admin || !v.writerEpoch) {
      if (timer) {
        clearTimeout(timer)
        this.healTimers.delete(board)
      }
      return
    }
    if (timer) return
    let delay = this.opts.healDelay.owner
    if (v.myRole !== 'owner') {
      const admins = v.members.filter((m) => m.role === 'admin').map((m) => m.pub).sort()
      const i = Math.max(0, admins.indexOf(this.identity.pub))
      delay = this.opts.healDelay.step * (i + 1) + Math.floor(Math.random() * 1000)
    }
    this.healTimers.set(
      board,
      setTimeout(() => {
        this.healTimers.delete(board)
        const now = this.view(board)
        if (!now?.needsHeal || RANK[now.myRole] < RANK.admin) return
        this.bg(this.write([rotateItem(now)]))
      }, delay),
    )
  }

  /** Run background work, keeping errors from going unhandled. */
  private bg(p: Promise<unknown>): void {
    const t = p.catch((e: unknown) => console.warn('lawha:', e))
    this.tasks.add(t)
    void t.finally(() => this.tasks.delete(t))
  }

  /** Resolves once no background work is pending (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks])
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    for (const t of this.healTimers.values()) clearTimeout(t)
    this.timers.clear()
    this.healTimers.clear()
  }
}

/** Owner plus everyone any stored set-role op names: whose chains we accept. */
function knownAuthors(view: BoardView): Set<string> {
  const known = new Set<string>()
  if (view.owner) known.add(view.owner)
  for (const m of view.resolved.aclOps) {
    const c = m.content as AclContent
    if (c.act === 'set-role') known.add(c.target)
    if (c.act === 'genesis' && boardIdFor(m.author, c.nonce) === view.id) known.add(m.author)
  }
  return known
}
