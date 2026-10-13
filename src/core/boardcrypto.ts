import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, randomBytes } from '@noble/hashes/utils.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { fromB64url, toB64url, u64, utf8 } from './b64'
import { PAD_BUCKETS } from './validate'
import type { EpochBlob, GrantBlob, Identity } from './types'

/**
 * Board encryption. Every board key "epoch" is a random 32-byte key, sealed
 * to each member with a fresh ephemeral X25519 key (the recipient's Ed25519
 * identity converted to Montgomery form, as in Shabaka's DMs). Content ops are
 * XChaCha20-Poly1305 under the epoch key, padded to fixed buckets so their
 * size says little about what they are.
 */

const WRAP_INFO = utf8('lawha-wrap-v1')
const GRANT_INFO = utf8('lawha-grant-v1')
const LOCAL_INFO = utf8('lawha-local-v1')
const KC_LABEL = utf8('lawha-kc')
const OP_LABEL = utf8('lawha-op-v1')

export type KeyRing = Map<string, Uint8Array>

export function randomId(): string {
  return toB64url(randomBytes(16))
}

export function keyCommitment(board: string, epochId: string, key: Uint8Array): string {
  return toB64url(sha256(concatBytes(KC_LABEL, fromB64url(board), fromB64url(epochId), key)))
}

function seal(key: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): string {
  const nonce = randomBytes(24)
  return toB64url(concatBytes(nonce, xchacha20poly1305(key, nonce, aad).encrypt(plaintext)))
}

function open(key: Uint8Array, aad: Uint8Array, sealed: string): Uint8Array | null {
  try {
    const bytes = fromB64url(sealed)
    return xchacha20poly1305(key, bytes.subarray(0, 24), aad).decrypt(bytes.subarray(24))
  } catch {
    return null
  }
}

/** Sender side: KEK for one recipient from the ephemeral secret. */
function kekTo(eph: Uint8Array, epk: Uint8Array, recipient: string, info: Uint8Array): Uint8Array {
  const pubBytes = fromB64url(recipient)
  const shared = x25519.getSharedSecret(eph, ed25519.utils.toMontgomery(pubBytes))
  return hkdf(sha256, shared, concatBytes(epk, pubBytes), info, 32)
}

/** Recipient side: the same KEK from our identity and the published epk. */
function kekFrom(me: Identity, epk: string, info: Uint8Array): Uint8Array | null {
  try {
    const epkBytes = fromB64url(epk)
    const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(me.seed), epkBytes)
    return hkdf(sha256, shared, concatBytes(epkBytes, me.pubBytes), info, 32)
  } catch {
    return null
  }
}

function wrapAad(board: string, epochId: string, pub: string): Uint8Array {
  return concatBytes(fromB64url(board), fromB64url(epochId), fromB64url(pub))
}

function carryAad(board: string, newId: string, prevId: string): Uint8Array {
  return concatBytes(fromB64url(board), fromB64url(newId), fromB64url(prevId))
}

/**
 * A new epoch key sealed to `recipients`, carrying every key in `carried`
 * (the epoch heads the creator holds) so it unlocks all history.
 */
export function createEpoch(
  board: string,
  recipients: string[],
  carried: KeyRing,
): { blob: EpochBlob; key: Uint8Array } {
  const key = randomBytes(32)
  const id = randomId()
  const eph = randomBytes(32)
  const epk = x25519.getPublicKey(eph)
  const wraps: Record<string, string> = {}
  for (const pub of new Set(recipients)) {
    try {
      wraps[pub] = seal(kekTo(eph, epk, pub, WRAP_INFO), wrapAad(board, id, pub), key)
    } catch {
      // a key that is not a usable curve point cannot receive anything
    }
  }
  const prev: Record<string, string> = {}
  for (const [prevId, prevKey] of carried) {
    if (prevId !== id) prev[prevId] = seal(key, carryAad(board, id, prevId), prevKey)
  }
  return {
    blob: { id, kc: keyCommitment(board, id, key), epk: toB64url(epk), wraps, prev },
    key,
  }
}

/** Our copy of an epoch key, or null if not sealed to us or not the committed key. */
export function openEpoch(board: string, blob: EpochBlob, me: Identity): Uint8Array | null {
  const sealed = blob.wraps[me.pub]
  if (!sealed) return null
  const kek = kekFrom(me, blob.epk, WRAP_INFO)
  if (!kek) return null
  const key = open(kek, wrapAad(board, blob.id, me.pub), sealed)
  if (!key || key.length !== 32) return null
  return keyCommitment(board, blob.id, key) === blob.kc ? key : null
}

/**
 * The older keys an epoch carries. Unverified here: the caller checks each
 * against its own epoch's commitment once that epoch's blob is known.
 */
export function openCarried(board: string, blob: EpochBlob, key: Uint8Array): KeyRing {
  const out: KeyRing = new Map()
  for (const [prevId, sealed] of Object.entries(blob.prev)) {
    const k = open(key, carryAad(board, blob.id, prevId), sealed)
    if (k && k.length === 32) out.set(prevId, k)
  }
  return out
}

/** Seal existing epoch keys to one member being added. */
export function createGrant(board: string, target: string, keys: KeyRing): GrantBlob | null {
  if (keys.size === 0) return null
  const eph = randomBytes(32)
  const epk = x25519.getPublicKey(eph)
  let kek: Uint8Array
  try {
    kek = kekTo(eph, epk, target, GRANT_INFO)
  } catch {
    return null
  }
  const sealed: Record<string, string> = {}
  for (const [epochId, key] of keys) sealed[epochId] = seal(kek, wrapAad(board, epochId, target), key)
  return { epk: toB64url(epk), keys: sealed }
}

export function openGrant(board: string, grant: GrantBlob, me: Identity): KeyRing {
  const out: KeyRing = new Map()
  const kek = kekFrom(me, grant.epk, GRANT_INFO)
  if (!kek) return out
  for (const [epochId, sealed] of Object.entries(grant.keys)) {
    const k = open(kek, wrapAad(board, epochId, me.pub), sealed)
    if (k && k.length === 32) out.set(epochId, k)
  }
  return out
}

// ---- content ops ----

export interface OpPosition {
  board: string
  author: string
  dev: string
  seq: number
  epoch: string
}

/** Binds the ciphertext to its exact place: no copying it to another board, author, seq or epoch. */
function opAad(p: OpPosition): Uint8Array {
  return concatBytes(
    OP_LABEL,
    fromB64url(p.board),
    fromB64url(p.author),
    fromB64url(p.dev),
    u64(p.seq),
    fromB64url(p.epoch),
  )
}

export function pad(bytes: Uint8Array): Uint8Array {
  const bucket = PAD_BUCKETS.find((b) => b >= bytes.length + 4)
  if (bucket === undefined) throw new Error('op too large')
  const out = new Uint8Array(bucket)
  new DataView(out.buffer).setUint32(0, bytes.length)
  out.set(bytes, 4)
  return out
}

export function unpad(padded: Uint8Array): Uint8Array | null {
  if (padded.length < 4) return null
  const len = new DataView(padded.buffer, padded.byteOffset).getUint32(0)
  if (len > padded.length - 4) return null
  return padded.subarray(4, 4 + len)
}

/** Largest op JSON (bytes) that fits the biggest bucket. */
export const MAX_OP_JSON = PAD_BUCKETS[PAD_BUCKETS.length - 1] - 4

export function opJsonSize(op: unknown): number {
  return utf8(JSON.stringify(op)).length
}

export function sealOp(key: Uint8Array, pos: OpPosition, op: unknown): { n: string; box: string } {
  const n = randomBytes(24)
  const box = xchacha20poly1305(key, n, opAad(pos)).encrypt(pad(utf8(JSON.stringify(op))))
  return { n: toB64url(n), box: toB64url(box) }
}

export function openOp(key: Uint8Array, pos: OpPosition, n: string, box: string): unknown {
  try {
    const padded = xchacha20poly1305(key, fromB64url(n), opAad(pos)).decrypt(fromB64url(box))
    const json = unpad(padded)
    if (!json) return undefined
    return JSON.parse(new TextDecoder().decode(json)) as unknown
  } catch {
    return undefined
  }
}

// ---- local at-rest cache (board names for the sidebar) ----

export function localKey(identity: Identity): Uint8Array {
  return hkdf(sha256, identity.seed, new Uint8Array(0), LOCAL_INFO, 32)
}

export function sealLocal(key: Uint8Array, text: string): { n: string; box: string } {
  const n = randomBytes(24)
  return { n: toB64url(n), box: toB64url(xchacha20poly1305(key, n).encrypt(utf8(text))) }
}

export function openLocal(key: Uint8Array, sealed: { n: string; box: string }): string | null {
  try {
    return new TextDecoder().decode(
      xchacha20poly1305(key, fromB64url(sealed.n)).decrypt(fromB64url(sealed.box)),
    )
  } catch {
    return null
  }
}
