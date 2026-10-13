import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { canonicalBytes } from './canonical'
import { fromB64url, toB64url } from './b64'
import type { AclContent, Envelope, EnvelopeType, Identity, OpContent } from './types'

export function signingBytes(env: Omit<Envelope, 'sig'>): Uint8Array {
  const { v, board, author, dev, seq, prev, ts, dep, type, content } = env
  return canonicalBytes({ v, board, author, dev, seq, prev, ts, dep, type, content })
}

/** Message ID commits to the signature too: sha256 over the full envelope. */
export function msgId(env: Envelope): string {
  const { v, board, author, dev, seq, prev, ts, dep, type, content, sig } = env
  return toB64url(
    sha256(canonicalBytes({ v, board, author, dev, seq, prev, ts, dep, type, content, sig })),
  )
}

/** Where on its chain a new envelope goes. */
export interface ChainPos {
  board: string
  dev: string
  /** this chain's current head, or null for the first envelope */
  head: { seq: number; id: string } | null
  /** the highest-clock envelope the writer has seen (null only for genesis) */
  dep: string | null
}

export function nextSeq(pos: ChainPos): number {
  return pos.head ? pos.head.seq + 1 : 1
}

export function createEnvelope(
  identity: Identity,
  pos: ChainPos,
  type: EnvelopeType,
  content: AclContent | OpContent,
  ts: number = Date.now(),
): Envelope {
  const unsigned = {
    v: 1 as const,
    board: pos.board,
    author: identity.pub,
    dev: pos.dev,
    seq: nextSeq(pos),
    prev: pos.head ? pos.head.id : null,
    ts,
    dep: pos.dep,
    type,
    content,
  }
  const sig = toB64url(ed25519.sign(signingBytes(unsigned), identity.seed))
  return { ...unsigned, sig }
}

/** Signature check only — schema and chain position are validate.ts's job. */
export function verifyEnvelope(env: Envelope): boolean {
  try {
    return ed25519.verify(fromB64url(env.sig), signingBytes(env), fromB64url(env.author))
  } catch {
    return false
  }
}

/** Strip local fields so only the signed wire shape leaves this device. */
export function toWire(m: Envelope): Envelope {
  const { v, board, author, dev, seq, prev, ts, dep, type, content, sig } = m
  return { v, board, author, dev, seq, prev, ts, dep, type, content, sig }
}

export function chainKey(m: { author: string; dev: string }): string {
  return `${m.author}.${m.dev}`
}
