import { ed25519 } from '@noble/curves/ed25519.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { B64_16, B64_32, B64_64, fromB64url, toB64url } from './b64'
import { canonicalBytes } from './canonical'
import { boardIdFor } from './acl'
import { chainKey, msgId, toWire, verifyEnvelope } from './envelope'
import { getBoardHeads, getChainRange, getMessageAt, putFork, putOrphan, type LawhaDb } from './db'
import { isB64, receiveEnvelope, schemaError, verifyForkProof } from './validate'
import type { AclContent, Envelope, ForkRecord, Identity, StoredMessage } from './types'

/**
 * Per-board gossip, adapted from Shabaka's: auth → status → have → want →
 * msgs, plus fork-proof gossip. Every peer connection belongs to exactly one
 * board room. A peer proves its key with a signature bound to both sides'
 * nonces and to the DTLS fingerprints of this very connection, so a
 * handshake cannot be relayed through a middleman. Logs are served only to
 * peers the board's current ACL says are members; data is accepted from any
 * authenticated peer, because every envelope is verified on its own.
 *
 * Two people rarely sit in the same board's room at the same moment, so
 * once a connection is authenticated it also carries every other board the
 * two share: one connection per remote install (its "carrier") offers the
 * boards whose ACL names them, and each accepted board runs its own session
 * (own handshake, own gate) wrapped in `mux` messages over that connection.
 */

export type SyncAction = 'auth' | 'status' | 'have' | 'want' | 'msgs' | 'forks' | 'offer' | 'mux'
export const SYNC_ACTIONS: SyncAction[] = ['auth', 'status', 'have', 'want', 'msgs', 'forks', 'offer', 'mux']
/** what a board session sends; `offer` and `mux` belong to the connection itself */
const SESSION_ACTIONS = new Set<string>(['auth', 'status', 'have', 'want', 'msgs', 'forks'])

/** What sync.ts sees of a transport — trivially mockable in tests. */
export interface PeerChannel {
  key: string
  board: string
  send(action: SyncAction, payload: unknown): void
  /** DTLS fingerprints of this connection (local = ours), or null if unavailable */
  fingerprints(): { local: string; remote: string } | null
}

export interface SyncHost {
  db(): LawhaDb
  identity: Identity
  dev: string
  /** may this key connect to this board's room at all (company roster gate) */
  mayConnect(board: string, pub: string): boolean
  /** should we serve this board's logs to this key (current member) */
  isMember(board: string, pub: string): boolean
  /** has the board's ACL ever named this author (or are they the owner) */
  isKnownAuthor(board: string, author: string): boolean
  /** boards to offer this key over a connection we already share: we hold them, their ACL names the key */
  shareable(pub: string): string[]
  /** take up a board this key offers: we hold it and its room would let them in */
  accepts(board: string, pub: string): boolean
  onIngested(board: string, msgs: StoredMessage[]): void
  onFork(board: string, fork: ForkRecord): void
  onOrphans?(board: string): void
  onPeerAuthed?(board: string, pub: string, member: boolean): void
  /** a remote install connected or went away */
  onPresence?(): void
  onBadPeer?(key: string): void
}

export const BATCH_SIZE = 50
const MAX_RANGE = 1000
const MAX_CHAINS = 2000
const MAX_BAD = 10
const MAX_OFFER = 500
const AUTH_CTX = 'lawha-auth-v1'

interface PeerState {
  ch: PeerChannel
  /** a board session carried over another connection: that connection's key */
  via: string | null
  nonce: string
  theirNonce: string | null
  theirSession: string | null
  pub: string | null
  dev: string | null
  /** they proved their key */
  authed: boolean
  /** we serve them this board's logs */
  served: boolean
  /** they told us they serve us */
  servesUs: boolean
  proofSent: boolean
  statusSent: boolean
  bad: number
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** the remote install a session talks to, once it proved its key */
const installOf = (p: PeerState | undefined): string | null => (p?.authed ? `${p.pub}.${p.dev}` : null)
const carriedKey = (via: string, board: string) => `${via}>${board}`

function authBytes(
  board: string,
  pub: string,
  dev: string,
  prover: { nonce: string; fp: string },
  verifier: { nonce: string; fp: string },
): Uint8Array {
  return canonicalBytes({ ctx: AUTH_CTX, board, pub, dev, prover, verifier })
}

export class SyncManager {
  readonly session: string
  private peers = new Map<string, PeerState>()
  /** remote install → the connection that offers it our shared boards */
  private carriers = new Map<string, string>()
  /** connection → boards it offered that we did not hold yet */
  private declined = new Map<string, Set<string>>()

  constructor(private host: SyncHost, session?: string) {
    this.session = session ?? toB64url(randomBytes(16))
  }

  private get db(): LawhaDb {
    return this.host.db()
  }

  onPeerJoin(ch: PeerChannel, via: string | null = null): void {
    const nonce = toB64url(randomBytes(16))
    this.peers.set(ch.key, {
      ch,
      via,
      nonce,
      theirNonce: null,
      theirSession: null,
      pub: null,
      dev: null,
      authed: false,
      served: false,
      servesUs: false,
      proofSent: false,
      statusSent: false,
      bad: 0,
    })
    ch.send('auth', { step: 'hi', nonce, session: this.session })
  }

  onPeerLeave(key: string): void {
    const gone = this.peers.get(key)
    if (!gone) return
    this.peers.delete(key)
    this.declined.delete(key)
    // the sessions it carried end with it
    for (const [k, p] of this.peers) if (p.via === key) this.peers.delete(k)
    const who = gone.via ? null : installOf(gone)
    if (!who) return
    this.host.onPresence?.()
    if (this.carriers.get(who) === key) {
      this.carriers.delete(who)
      const next = [...this.peers.values()].find((p) => !p.via && installOf(p) === who)
      if (next) this.carriers.set(who, next.ch.key)
    }
    // whatever this connection covered goes over the carrier now
    const carrier = this.peers.get(this.carriers.get(who) ?? '')
    if (carrier) this.offer(carrier)
  }

  /** Connected remote installs (each counted once, however many rooms and transports). */
  installs(): number {
    return new Set([...this.peers.values()].filter((p) => !p.via).map(installOf).filter(Boolean)).size
  }

  peersOf(board: string): Array<{ key: string; pub: string | null; served: boolean; servesUs: boolean }> {
    return [...this.peers.values()]
      .filter((p) => p.ch.board === board && p.authed)
      .map((p) => ({ key: p.ch.key, pub: p.pub, served: p.served, servesUs: p.servesUs }))
  }

  async onMessage(ch: PeerChannel, action: SyncAction, payload: unknown): Promise<void> {
    const peer = this.peers.get(ch.key)
    if (!peer) return
    if (action === 'auth') return this.handleAuth(peer, payload)
    if (!peer.authed) return
    switch (action) {
      case 'offer':
        return this.handleOffer(peer, payload)
      case 'mux':
        return this.handleMux(peer, payload)
      case 'status':
        if (isObj(payload)) peer.servesUs = payload.member === 1
        return
      case 'have':
        return this.handleHave(peer, payload)
      case 'want':
        return this.handleWant(peer, payload)
      case 'msgs':
        return this.handleMsgs(peer, payload)
      case 'forks':
        return this.handleForks(peer, payload)
    }
  }

  // ---- authentication ----

  private handleAuth(peer: PeerState, p: unknown): void {
    if (!isObj(p)) return
    if (p.step === 'hi') {
      if (!isB64(p.nonce, B64_16) || typeof p.session !== 'string') return
      peer.theirNonce = p.nonce
      peer.theirSession = p.session.slice(0, 64)
      // ours may have reached them before they had the session (one they
      // took up later, or a join they had not seen yet): say it once more
      if (p.re !== 1) peer.ch.send('auth', { step: 'hi', nonce: peer.nonce, session: this.session, re: 1 })
      if (!peer.proofSent) this.sendProof(peer)
      return
    }
    if (p.step === 'proof') {
      if (peer.authed || !peer.theirNonce) return
      if (!isB64(p.pub, B64_32) || !isB64(p.dev, B64_16) || !isB64(p.sig, B64_64)) return
      const fp = peer.ch.fingerprints()
      const bytes = authBytes(
        peer.ch.board,
        p.pub,
        p.dev,
        { nonce: peer.theirNonce, fp: fp?.remote ?? '' },
        { nonce: peer.nonce, fp: fp?.local ?? '' },
      )
      let ok = false
      try {
        ok = ed25519.verify(fromB64url(p.sig), bytes, fromB64url(p.pub))
      } catch {
        ok = false
      }
      if (!ok) return
      if (!this.host.mayConnect(peer.ch.board, p.pub)) {
        this.peers.delete(peer.ch.key)
        this.host.onBadPeer?.(peer.ch.key)
        return
      }
      if (peer.via) {
        // a carried session speaks for the install that carries it, no one else
        const base = this.peers.get(peer.via)
        if (!base || base.pub !== p.pub || base.dev !== p.dev) {
          this.peers.delete(peer.ch.key)
          return
        }
      }
      peer.pub = p.pub
      peer.dev = p.dev
      peer.authed = true
      void this.updateGate(peer)
      if (!peer.via) {
        this.host.onPresence?.()
        const who = installOf(peer)!
        if (!this.peers.has(this.carriers.get(who) ?? '')) {
          this.carriers.set(who, peer.ch.key)
          this.offer(peer)
        }
      }
    }
  }

  // ---- shared boards over one connection ----

  /** Offer, over a carrier, every shared board no session with that install covers yet. */
  private offer(carrier: PeerState): void {
    const who = installOf(carrier)
    if (!who || carrier.via) return
    const covered = new Set<string>()
    for (const p of this.peers.values()) {
      if ((p.via ? installOf(this.peers.get(p.via)) : installOf(p)) === who) covered.add(p.ch.board)
    }
    const boards = this.host
      .shareable(carrier.pub!)
      .filter((b) => !covered.has(b))
      .slice(0, MAX_OFFER)
    if (boards.length === 0) return
    carrier.ch.send('offer', { boards })
    for (const b of boards) this.openCarried(carrier, b)
  }

  private openCarried(base: PeerState, board: string): void {
    const key = carriedKey(base.ch.key, board)
    if (this.peers.has(key)) return
    this.onPeerJoin(
      {
        key,
        board,
        send: (action, payload) => base.ch.send('mux', { b: board, a: action, p: payload }),
        fingerprints: () => base.ch.fingerprints(),
      },
      base.ch.key,
    )
  }

  private handleOffer(base: PeerState, p: unknown): void {
    if (base.via || !isObj(p) || !Array.isArray(p.boards)) return
    const declined = this.declined.get(base.ch.key) ?? new Set<string>()
    for (const b of p.boards.slice(0, MAX_OFFER)) {
      if (!isB64(b, B64_32) || b === base.ch.board || this.peers.has(carriedKey(base.ch.key, b))) continue
      if (this.host.accepts(b, base.pub!)) this.openCarried(base, b)
      else if (declined.size < MAX_OFFER) declined.add(b)
    }
    if (declined.size > 0) this.declined.set(base.ch.key, declined)
  }

  private handleMux(base: PeerState, p: unknown): Promise<void> | void {
    if (base.via || !isObj(p) || typeof p.b !== 'string' || typeof p.a !== 'string' || !SESSION_ACTIONS.has(p.a)) return
    const carried = this.peers.get(carriedKey(base.ch.key, p.b))
    if (carried) return this.onMessage(carried.ch, p.a as SyncAction, p.p)
  }

  /** The boards we hold or their ACLs changed: take up offers we can now, offer what became shared. */
  reoffer(): void {
    for (const [key, boards] of this.declined) {
      const base = this.peers.get(key)
      if (!base) continue
      for (const b of boards) {
        if (!this.host.accepts(b, base.pub!)) continue
        boards.delete(b)
        this.openCarried(base, b)
      }
    }
    for (const key of this.carriers.values()) {
      const carrier = this.peers.get(key)
      if (carrier) this.offer(carrier)
    }
  }

  private sendProof(peer: PeerState): void {
    if (!peer.theirNonce) return
    const fp = peer.ch.fingerprints()
    const me = this.host.identity
    const bytes = authBytes(
      peer.ch.board,
      me.pub,
      this.host.dev,
      { nonce: peer.nonce, fp: fp?.local ?? '' },
      { nonce: peer.theirNonce, fp: fp?.remote ?? '' },
    )
    peer.proofSent = true
    peer.ch.send('auth', {
      step: 'proof',
      pub: me.pub,
      dev: this.host.dev,
      sig: toB64url(ed25519.sign(bytes, me.seed)),
    })
  }

  /** Re-evaluate whether each peer of `board` gets served (call on any ACL change). */
  async refreshGate(board: string): Promise<void> {
    for (const peer of this.peers.values()) {
      if (peer.ch.board === board && peer.authed) await this.updateGate(peer)
    }
  }

  private async updateGate(peer: PeerState): Promise<void> {
    const member = this.host.isMember(peer.ch.board, peer.pub!)
    const changed = member !== peer.served
    peer.served = member
    if (changed || !peer.statusSent) {
      peer.statusSent = true
      peer.ch.send('status', { member: member ? 1 : 0 })
      this.host.onPeerAuthed?.(peer.ch.board, peer.pub!, member)
    }
    if (member && changed) await this.sendHave(peer)
  }

  // ---- anti-entropy ----

  /** Periodic anti-entropy: re-offer heads to everyone we serve. */
  async resyncAll(board?: string): Promise<void> {
    for (const peer of this.peers.values()) {
      if (peer.served && (!board || peer.ch.board === board)) await this.sendHave(peer)
    }
  }

  private async sendHave(peer: PeerState): Promise<void> {
    const heads = await getBoardHeads(this.db, peer.ch.board)
    const chains: Record<string, [number, string]> = {}
    for (const h of heads.slice(0, MAX_CHAINS)) chains[chainKey(h)] = [h.seq, h.id]
    peer.ch.send('have', { chains })
  }

  private async handleHave(peer: PeerState, p: unknown): Promise<void> {
    if (!isObj(p) || !isObj(p.chains)) return
    const board = peer.ch.board
    const mine = new Map((await getBoardHeads(this.db, board)).map((h) => [chainKey(h), h]))
    const want: Record<string, { from: number; to: number }> = {}
    for (const [key, v] of Object.entries(p.chains).slice(0, MAX_CHAINS)) {
      if (!Array.isArray(v) || v.length !== 2) continue
      const [seq, id] = v as [unknown, unknown]
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1 || typeof id !== 'string') continue
      const [author, dev] = key.split('.')
      if (!isB64(author, B64_32) || !isB64(dev, B64_16)) continue
      const head = mine.get(key)
      const have = head?.seq ?? 0
      if (seq > have) {
        want[key] = { from: have + 1, to: seq }
      } else {
        // same length or shorter: a different id at their head means equivocation
        const ours = seq === have ? head!.id : (await getMessageAt(this.db, board, author!, dev!, seq))?.id
        if (ours && ours !== id) want[key] = { from: seq, to: seq }
      }
    }
    if (Object.keys(want).length > 0) peer.ch.send('want', want)
  }

  private async handleWant(peer: PeerState, p: unknown): Promise<void> {
    if (!peer.served || !isObj(p)) return
    for (const [key, range] of Object.entries(p).slice(0, MAX_CHAINS)) {
      if (!isObj(range)) continue
      const [author, dev] = key.split('.')
      if (!isB64(author, B64_32) || !isB64(dev, B64_16)) continue
      const { from, to } = range
      if (
        typeof from !== 'number' ||
        typeof to !== 'number' ||
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        from < 1 ||
        to < from
      )
        continue
      const msgs = await getChainRange(this.db, peer.ch.board, author!, dev!, from, Math.min(to, from + MAX_RANGE - 1))
      for (let i = 0; i < msgs.length; i += BATCH_SIZE) {
        peer.ch.send('msgs', { batch: msgs.slice(i, i + BATCH_SIZE).map(toWire) })
      }
    }
  }

  private isGenesisFor(board: string, env: Envelope): boolean {
    if (env.type !== 'acl' || !isObj(env.content)) return false
    const c = env.content as AclContent
    return c.act === 'genesis' && typeof c.nonce === 'string' && isB64(env.author, B64_32) && boardIdFor(env.author, c.nonce) === board
  }

  /** Batches for one board are processed one at a time: chain checks read-then-write. */
  private queues = new Map<string, Promise<void>>()

  private handleMsgs(peer: PeerState, p: unknown): Promise<void> {
    const board = peer.ch.board
    const next = (this.queues.get(board) ?? Promise.resolve()).then(() => this.processMsgs(peer, p))
    const settled = next.catch(() => undefined)
    this.queues.set(board, settled)
    void settled.then(() => {
      if (this.queues.get(board) === settled) this.queues.delete(board)
    })
    return next
  }

  private async processMsgs(peer: PeerState, p: unknown): Promise<void> {
    if (!isObj(p) || !Array.isArray(p.batch) || p.batch.length > BATCH_SIZE * 2) return
    const board = peer.ch.board
    const accepted: StoredMessage[] = []
    const gaps = new Map<string, { from: number; to: number }>()
    let orphaned = false
    // authors this batch itself introduces (a genesis, or set-role targets)
    const introduced = new Set<string>()

    for (const raw of p.batch) {
      if (!isObj(raw) || raw.board !== board) {
        if (++peer.bad >= MAX_BAD) return this.dropBad(peer)
        continue
      }
      const env = raw as unknown as Envelope
      const genesis = this.isGenesisFor(board, env)
      if (!genesis && !introduced.has(env.author) && !this.host.isKnownAuthor(board, env.author)) {
        // from someone the ACL never named: park it, promoted once they are
        if (schemaError(env) || !verifyEnvelope(env)) {
          if (++peer.bad >= MAX_BAD) return this.dropBad(peer)
          continue
        }
        await putOrphan(this.db, { ...toWire(env), id: msgId(env), receivedAt: Date.now() })
        orphaned = true
        continue
      }
      const r = await receiveEnvelope(this.db, env)
      if (r.status === 'invalid') {
        if (++peer.bad >= MAX_BAD) return this.dropBad(peer)
        continue
      }
      accepted.push(...r.accepted)
      // a verified genesis or set-role names authors whose chains we want,
      // even when we already had it (duplicate) or it waits on a gap (pending)
      if (env.type === 'acl') {
        const c = env.content as AclContent
        if (genesis) introduced.add(env.author)
        if (c.act === 'set-role' && (introduced.has(env.author) || this.host.isKnownAuthor(board, env.author))) {
          introduced.add(c.target)
        }
      }
      if (r.gap) {
        const k = `${r.gap.author}.${r.gap.dev}`
        const ex = gaps.get(k)
        gaps.set(k, { from: Math.min(ex?.from ?? r.gap.from, r.gap.from), to: Math.max(ex?.to ?? r.gap.to, r.gap.to) })
      }
      if (r.fork) this.announceFork(board, r.fork, null)
    }

    if (gaps.size > 0) peer.ch.send('want', Object.fromEntries(gaps))
    if (orphaned) this.host.onOrphans?.(board)
    if (accepted.length > 0) {
      this.host.onIngested(board, accepted)
      this.push(board, accepted, peer.ch.key, peer.theirSession)
    }
  }

  private dropBad(peer: PeerState): void {
    this.onPeerLeave(peer.ch.key)
    this.host.onBadPeer?.(peer.ch.key)
  }

  private async handleForks(peer: PeerState, p: unknown): Promise<void> {
    if (!isObj(p) || !Array.isArray(p.proofs)) return
    for (const raw of p.proofs.slice(0, 20)) {
      const fork = verifyForkProof(raw)
      if (!fork || fork.board !== peer.ch.board) continue
      if (await putFork(this.db, fork)) this.announceFork(peer.ch.board, fork, peer.ch.key)
    }
  }

  private announceFork(board: string, fork: ForkRecord, exclude: string | null): void {
    this.host.onFork(board, fork)
    for (const peer of this.peers.values()) {
      if (peer.ch.board === board && peer.served && peer.ch.key !== exclude) {
        peer.ch.send('forks', { proofs: [{ a: fork.a, b: fork.b }] })
      }
    }
  }

  /**
   * Eager gossip to every served peer of the board except the source (and
   * any channel sharing the source's session, i.e. the same client on another
   * transport). Duplicates elsewhere are harmless: receivers dedupe by msgId.
   */
  push(
    board: string,
    msgs: Array<StoredMessage | Envelope>,
    excludeKey: string | null = null,
    excludeSession: string | null = null,
  ): void {
    const batch = msgs.filter((m) => m.board === board).map(toWire)
    if (batch.length === 0) return
    const sessions = new Set<string>()
    for (const [key, peer] of this.peers) {
      if (peer.ch.board !== board || !peer.served || key === excludeKey) continue
      if (peer.theirSession !== null) {
        if (peer.theirSession === excludeSession || sessions.has(peer.theirSession)) continue
        sessions.add(peer.theirSession)
      }
      for (let i = 0; i < batch.length; i += BATCH_SIZE) {
        peer.ch.send('msgs', { batch: batch.slice(i, i + BATCH_SIZE) })
      }
    }
  }
}
