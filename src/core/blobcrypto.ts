import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, randomBytes } from '@noble/hashes/utils.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { toB64url, utf8 } from './b64'

/**
 * Attachments. A file is cut into pieces of `ps` bytes, each sealed with
 * XChaCha20-Poly1305 under a key of its own: random per file and carried only
 * inside the `attach.add` op, which is sealed under the board key like any
 * other op. So a removed member never learns the key of a file added after
 * they left, and rotating the board key re-encrypts nothing.
 *
 * The op also lists the SHA-256 of every sealed piece (`hashes`), and the
 * file is addressed by `root`, a hash of that list. Signed into the op, it
 * pins the exact bytes: whoever relays a piece can check it before storing or
 * passing it on, and an author cannot show different people different files.
 * The piece index and count are in each piece's AAD, so pieces can be neither
 * reordered nor dropped from the end.
 */

/** what this version cuts files into */
export const PIECE_SIZE = 256 * 1024
export const MIN_PIECE = 1 << 16
export const MAX_PIECE = 1 << 20
export const MAX_PIECES = 100
/** what this version uploads; the op schema allows MAX_PIECES × ps */
export const MAX_FILE = 25 * 1024 * 1024
export const HASH_BYTES = 32
export const TAG_BYTES = 16

const BLOB_LABEL = utf8('lawha-blob-v1')

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n)
  return out
}

/** The key is unique to the file and each index is sealed once: a counter nonce is safe. */
function pieceNonce(i: number): Uint8Array {
  const n = new Uint8Array(24)
  new DataView(n.buffer).setUint32(0, i)
  return n
}

function pieceAad(i: number, n: number): Uint8Array {
  return concatBytes(BLOB_LABEL, u32(i), u32(n))
}

export function pieceCount(size: number, ps: number): number {
  return Math.max(1, Math.ceil(size / ps))
}

/** Bytes of sealed piece `i` of a file of `size` bytes. */
export function sealedPieceLen(size: number, ps: number, i: number): number {
  const n = pieceCount(size, ps)
  return (i < n - 1 ? ps : size - ps * (n - 1)) + TAG_BYTES
}

export function newFileKey(): Uint8Array {
  return randomBytes(32)
}

export function sealPiece(key: Uint8Array, i: number, n: number, plain: Uint8Array): Uint8Array {
  return xchacha20poly1305(key, pieceNonce(i), pieceAad(i, n)).encrypt(plain)
}

export function openPiece(key: Uint8Array, i: number, n: number, sealed: Uint8Array): Uint8Array | null {
  try {
    return xchacha20poly1305(key, pieceNonce(i), pieceAad(i, n)).decrypt(sealed)
  } catch {
    return null
  }
}

export function rootOf(hashes: Uint8Array): string {
  return toB64url(sha256(concatBytes(BLOB_LABEL, hashes)))
}

/** Whether `sealed` is piece `i` of the file whose piece hashes are `hashes`. */
export function pieceMatches(hashes: Uint8Array, i: number, sealed: Uint8Array): boolean {
  const want = hashes.subarray(i * HASH_BYTES, (i + 1) * HASH_BYTES)
  if (want.length !== HASH_BYTES) return false
  const got = sha256(sealed)
  let diff = 0
  for (let k = 0; k < HASH_BYTES; k++) diff |= got[k]! ^ want[k]!
  return diff === 0
}

export interface SealedFile {
  key: Uint8Array
  pieces: Uint8Array[]
  hashes: Uint8Array
  root: string
}

/** Seal a whole file. `pause` runs between pieces (the UI yields there, to stay responsive). */
export async function sealFile(
  bytes: Uint8Array,
  ps = PIECE_SIZE,
  pause: () => Promise<void> = async () => undefined,
): Promise<SealedFile> {
  const key = newFileKey()
  const n = pieceCount(bytes.length, ps)
  const pieces: Uint8Array[] = []
  const hashes = new Uint8Array(n * HASH_BYTES)
  for (let i = 0; i < n; i++) {
    const sealed = sealPiece(key, i, n, bytes.subarray(i * ps, (i + 1) * ps))
    pieces.push(sealed)
    hashes.set(sha256(sealed), i * HASH_BYTES)
    await pause()
  }
  return { key, pieces, hashes, root: rootOf(hashes) }
}
