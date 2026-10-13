import { B64_16, B64_24, B64_32, B64_64, isCanonicalB64url } from './b64'
import { canonicalize } from './canonical'
import { msgId, verifyEnvelope } from './envelope'
import {
  deletePending,
  getHead,
  getMessage,
  getMessageAt,
  getPendingAt,
  putFork,
  putPending,
  type LawhaDb,
} from './db'
import type { Envelope, ForkRecord, Head, StoredMessage } from './types'

/** ACL envelopes carry key wraps for every member, so they get more room. */
export const MAX_ACL_BYTES = 65536
export const MAX_OP_BYTES = 24576
export const MAX_MEMBERS = 250
/** devices listed in one cutoff; unlisted devices are cut at 0 */
export const MAX_UPTO = 128
/** ACL heads one envelope may reference */
export const MAX_ACL_REFS = 32
/** epoch keys carried forward / granted in one envelope */
export const MAX_CARRIED_KEYS = 64
/** padded plaintext sizes; ciphertext length leaks only the bucket */
export const PAD_BUCKETS = [256, 1024, 4096, 16384] as const

/** b64url length of `n` bytes */
export function b64Len(n: number): number {
  return Math.ceil((n * 4) / 3)
}
/** a sealed 32-byte key: 24-byte nonce ‖ 32-byte ciphertext ‖ 16-byte tag */
export const SEALED_KEY_BYTES = 72
const SEALED_KEY_LEN = b64Len(SEALED_KEY_BYTES)
const OP_BOX_LENS = new Set(PAD_BUCKETS.map((b) => b64Len(b + 16)))

const ENVELOPE_KEYS = ['v', 'board', 'author', 'dev', 'seq', 'prev', 'ts', 'dep', 'type', 'content', 'sig']

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

export function isB64(s: unknown, len: number): s is string {
  return typeof s === 'string' && s.length === len && isCanonicalB64url(s)
}

function isSeq(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1
}

function hasExactKeys(obj: object, keys: string[]): boolean {
  const own = Object.keys(obj)
  return own.length === keys.length && keys.every((k) => own.includes(k))
}

function isRefList(x: unknown, max: number): x is string[] {
  return (
    Array.isArray(x) &&
    x.length <= max &&
    x.every((r) => isB64(r, B64_32)) &&
    new Set(x).size === x.length
  )
}

/** Record<string, sealedKey> with keys of the given b64url length. */
function isSealedMap(x: unknown, keyLen: number, max: number): boolean {
  if (!isObj(x)) return false
  const entries = Object.entries(x)
  return (
    entries.length <= max && entries.every(([k, v]) => isB64(k, keyLen) && isB64(v, SEALED_KEY_LEN))
  )
}

function isEpoch(x: unknown): boolean {
  return (
    isObj(x) &&
    hasExactKeys(x, ['id', 'kc', 'epk', 'wraps', 'prev']) &&
    isB64(x.id, B64_16) &&
    isB64(x.kc, B64_32) &&
    isB64(x.epk, B64_32) &&
    isSealedMap(x.wraps, B64_32, MAX_MEMBERS) &&
    Object.keys(x.wraps as object).length >= 1 &&
    isSealedMap(x.prev, B64_16, MAX_CARRIED_KEYS)
  )
}

function isGrant(x: unknown): boolean {
  return (
    isObj(x) &&
    hasExactKeys(x, ['epk', 'keys']) &&
    isB64(x.epk, B64_32) &&
    isSealedMap(x.keys, B64_16, MAX_CARRIED_KEYS) &&
    Object.keys(x.keys as object).length >= 1
  )
}

function isUpTo(x: unknown): boolean {
  if (!isObj(x)) return false
  const entries = Object.entries(x)
  return (
    entries.length <= MAX_UPTO &&
    entries.every(
      ([dev, v]) =>
        isB64(dev, B64_16) && Array.isArray(v) && v.length === 2 && isSeq(v[0]) && isB64(v[1], B64_32),
    )
  )
}

function aclError(c: Record<string, unknown>, author: string): string | null {
  switch (c.act) {
    case 'genesis':
      if (
        !hasExactKeys(c, ['act', 'acl', 'nonce', 'kind', 'ws', 'epoch']) ||
        !Array.isArray(c.acl) ||
        c.acl.length !== 0 ||
        !isB64(c.nonce, B64_16) ||
        !(
          (c.kind === 'board' && (c.ws === null || isB64(c.ws, B64_32))) ||
          (c.kind === 'workspace' && c.ws === null)
        ) ||
        !isEpoch(c.epoch)
      )
        return 'bad genesis'
      return null
    case 'set-role':
      if (
        !hasExactKeys(c, ['act', 'acl', 'target', 'role', 'upTo', 'grant']) ||
        !isRefList(c.acl, MAX_ACL_REFS) ||
        !isB64(c.target, B64_32) ||
        c.target === author ||
        !(c.role === 'admin' || c.role === 'editor' || c.role === 'viewer') ||
        !isUpTo(c.upTo) ||
        !(c.grant === null || isGrant(c.grant))
      )
        return 'bad set-role'
      return null
    case 'remove':
      if (
        !hasExactKeys(c, ['act', 'acl', 'target', 'upTo', 'epoch']) ||
        !isRefList(c.acl, MAX_ACL_REFS) ||
        !isB64(c.target, B64_32) ||
        c.target === author ||
        !isUpTo(c.upTo) ||
        !isEpoch(c.epoch)
      )
        return 'bad remove'
      return null
    case 'leave':
      if (!hasExactKeys(c, ['act', 'acl', 'upTo']) || !isRefList(c.acl, MAX_ACL_REFS) || !isUpTo(c.upTo))
        return 'bad leave'
      return null
    case 'rotate':
      if (!hasExactKeys(c, ['act', 'acl', 'epoch']) || !isRefList(c.acl, MAX_ACL_REFS) || !isEpoch(c.epoch))
        return 'bad rotate'
      return null
    default:
      return 'unknown acl act'
  }
}

function opError(c: Record<string, unknown>): string | null {
  if (
    !hasExactKeys(c, ['acl', 'epoch', 'n', 'box']) ||
    !isRefList(c.acl, MAX_ACL_REFS) ||
    c.acl.length === 0 ||
    !isB64(c.epoch, B64_16) ||
    !isB64(c.n, B64_24) ||
    typeof c.box !== 'string' ||
    !OP_BOX_LENS.has(c.box.length) ||
    !isCanonicalB64url(c.box)
  )
    return 'bad op content'
  return null
}

/** Full structural validation of an untrusted envelope. Null = OK. */
export function schemaError(env: unknown): string | null {
  if (!isObj(env)) return 'not an object'
  const e = env
  if (!hasExactKeys(e, ENVELOPE_KEYS)) return 'wrong envelope keys'
  if (e.v !== 1) return 'unknown version'
  if (!isB64(e.board, B64_32)) return 'bad board'
  if (!isB64(e.author, B64_32)) return 'bad author'
  if (!isB64(e.dev, B64_16)) return 'bad dev'
  if (!isSeq(e.seq)) return 'bad seq'
  if (e.seq === 1 ? e.prev !== null : !isB64(e.prev, B64_32)) return 'bad prev'
  if (typeof e.ts !== 'number' || !Number.isSafeInteger(e.ts) || e.ts < 0) return 'bad ts'
  if (!(e.dep === null || isB64(e.dep, B64_32))) return 'bad dep'
  if (!isB64(e.sig, B64_64)) return 'bad sig encoding'
  if (!isObj(e.content)) return 'bad content'
  let cErr: string | null
  if (e.type === 'acl') cErr = aclError(e.content, e.author)
  else if (e.type === 'op') cErr = opError(e.content)
  else return 'unknown type'
  if (cErr) return cErr
  try {
    const max = e.type === 'acl' ? MAX_ACL_BYTES : MAX_OP_BYTES
    if (canonicalize(env).length > max) return 'envelope too large'
  } catch {
    return 'non-canonical values'
  }
  return null
}

export type ReceiveStatus = 'accepted' | 'duplicate' | 'pending' | 'invalid' | 'forked' | 'conflict'

export interface ReceiveOutcome {
  status: ReceiveStatus
  reason?: string
  /** newly ingested messages, including any drained from the pending buffer */
  accepted: StoredMessage[]
  /** chain range to request from the sending peer */
  gap?: { author: string; dev: string; from: number; to: number }
  /** a newly proven equivocation, to gossip */
  fork?: ForkRecord
}

/**
 * Write an already-validated next-in-chain envelope. Message and head land in
 * one transaction so they can never disagree.
 */
export async function ingestValidated(
  db: LawhaDb,
  env: Envelope,
  id: string,
  receivedAt: number = Date.now(),
): Promise<StoredMessage> {
  const stored: StoredMessage = { ...env, id, receivedAt }
  const tx = db.transaction(['messages', 'heads'], 'readwrite')
  await tx.objectStore('messages').put(stored)
  const head: Head = { board: env.board, author: env.author, dev: env.dev, seq: env.seq, id }
  await tx.objectStore('heads').put(head)
  await tx.done
  return stored
}

/**
 * The security boundary for everything that arrives from the network:
 * schema → dedupe → signature → chain position. Accepting an envelope drains
 * any directly-connectable successors from the pending buffer. Permissions
 * are NOT checked here — they depend on ACL ops that may arrive later, so the
 * fold (acl.ts / board.ts) evaluates them over the whole stored set.
 */
export async function receiveEnvelope(
  db: LawhaDb,
  env: Envelope,
  receivedAt: number = Date.now(),
): Promise<ReceiveOutcome> {
  const err = schemaError(env)
  if (err) return { status: 'invalid', reason: err, accepted: [] }

  const id = msgId(env)
  if (await getMessage(db, id)) return { status: 'duplicate', accepted: [] }

  if (!verifyEnvelope(env)) return { status: 'invalid', reason: 'bad signature', accepted: [] }

  const head = await getHead(db, env.board, env.author, env.dev)
  const nextSeq = head ? head.seq + 1 : 1

  if (env.seq === nextSeq) {
    if (head && env.prev !== head.id) {
      // right position, different history: the device signed two envelopes
      // at head.seq. Ask for theirs to complete the proof.
      return {
        status: 'conflict',
        accepted: [],
        gap: { author: env.author, dev: env.dev, from: head.seq, to: head.seq },
      }
    }
    const accepted = [await ingestValidated(db, env, id, receivedAt)]
    await drainPending(db, accepted)
    return { status: 'accepted', accepted }
  }

  if (env.seq > nextSeq) {
    await putPending(db, { ...env, id, receivedAt })
    return {
      status: 'pending',
      accepted: [],
      gap: { author: env.author, dev: env.dev, from: nextSeq, to: env.seq - 1 },
    }
  }

  // seq <= head.seq with an unknown id: equivocation, and we hold the proof.
  const ours = await getMessageAt(db, env.board, env.author, env.dev, env.seq)
  if (!ours) return { status: 'invalid', reason: 'missing chain entry', accepted: [] }
  // the same envelope stored meanwhile by a concurrent receive: not a fork
  if (ours.id === id) return { status: 'duplicate', accepted: [] }
  const fork: ForkRecord = {
    board: env.board,
    author: env.author,
    dev: env.dev,
    seq: env.seq,
    a: stripLocal(ours),
    b: env,
  }
  const isNew = await putFork(db, fork)
  return { status: 'forked', accepted: [], fork: isNew ? fork : undefined }
}

function stripLocal(m: StoredMessage): Envelope {
  const { id: _id, receivedAt: _r, ...env } = m
  return env
}

async function drainPending(db: LawhaDb, accepted: StoredMessage[]): Promise<void> {
  for (;;) {
    const last = accepted[accepted.length - 1]!
    const next = await getPendingAt(db, last.board, last.author, last.dev, last.seq + 1)
    if (!next) return
    await deletePending(db, next.id)
    if (next.prev !== last.id) return // pending entry from a forked history
    accepted.push(await ingestValidated(db, stripLocal(next), next.id, next.receivedAt))
  }
}

/**
 * Check a gossiped fork proof: two validly signed envelopes from one device at
 * one seq with different ids. Returns the normalized record or null.
 */
export function verifyForkProof(x: unknown): ForkRecord | null {
  if (!isObj(x) || !isObj(x.a) || !isObj(x.b)) return null
  const a = x.a as unknown as Envelope
  const b = x.b as unknown as Envelope
  if (schemaError(a) || schemaError(b)) return null
  if (a.board !== b.board || a.author !== b.author || a.dev !== b.dev || a.seq !== b.seq) return null
  if (msgId(a) === msgId(b)) return null
  if (!verifyEnvelope(a) || !verifyEnvelope(b)) return null
  return { board: a.board, author: a.author, dev: a.dev, seq: a.seq, a, b }
}
