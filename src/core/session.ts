import { identityFromSeed } from './identity'
import { getSessionRecord, putSessionRecord, deleteSessionRecord, type LawhaDb } from './db'
import type { Identity } from './types'

/**
 * "Stay signed in" — persist the ability to unlock without the passphrase for a
 * bounded window. The seed is encrypted under a freshly generated AES-GCM key
 * created with `extractable: false`, so the browser holds the key but never
 * exposes its raw bytes to JavaScript (an XSS payload can use it while the app
 * is open — which it could do to the live seed anyway — but cannot copy it out
 * for offline reuse). The key handle and ciphertext live in IndexedDB together;
 * expiry is enforced on read.
 */

export interface SessionDuration {
  /** stable id, also the i18n key suffix (see ui/i18n.ts) */
  id: string
  ms: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const SESSION_DURATIONS: readonly SessionDuration[] = [
  { id: '5m', ms: 5 * MINUTE },
  { id: '60m', ms: 60 * MINUTE },
  { id: '90m', ms: 90 * MINUTE },
  { id: '1d', ms: DAY },
  { id: '3d', ms: 3 * DAY },
  { id: '1w', ms: 7 * DAY },
  { id: '1mo', ms: 30 * DAY },
  { id: '3mo', ms: 90 * DAY },
]

export const MAX_SESSION_MS = 90 * DAY

function subtle(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) throw new Error('WebCrypto unavailable')
  return c.subtle
}

/** WebCrypto's BufferSource excludes SharedArrayBuffer-backed views; normalize. */
function buf(u: Uint8Array): Uint8Array<ArrayBuffer> {
  return u.buffer instanceof ArrayBuffer
    ? (u as Uint8Array<ArrayBuffer>)
    : new Uint8Array(u)
}

/** True where a session can be created (secure context with WebCrypto). */
export function sessionsSupported(): boolean {
  return !!globalThis.crypto?.subtle
}

/**
 * Encrypt `identity`'s seed under a new non-extractable key and store it,
 * valid for `durationMs` (clamped to MAX_SESSION_MS). Returns the expiry epoch.
 */
export async function createSession(
  db: LawhaDb,
  identity: Identity,
  durationMs: number,
  now: number = Date.now(),
): Promise<number> {
  const clamped = Math.min(Math.max(durationMs, 0), MAX_SESSION_MS)
  const key = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const box = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, buf(identity.seed)))
  const expiresAt = now + clamped
  await putSessionRecord(db, {
    id: 'self',
    pub: identity.pub,
    key,
    iv,
    box,
    createdAt: now,
    expiresAt,
  })
  return expiresAt
}

/**
 * Recover the identity from an unexpired session, or null if there is none /
 * it expired / it failed to decrypt. Any unusable record is deleted.
 */
export async function loadSession(
  db: LawhaDb,
  now: number = Date.now(),
): Promise<Identity | null> {
  const rec = await getSessionRecord(db)
  if (!rec) return null
  if (rec.expiresAt <= now) {
    await deleteSessionRecord(db)
    return null
  }
  let seed: Uint8Array
  try {
    seed = new Uint8Array(
      await subtle().decrypt({ name: 'AES-GCM', iv: buf(rec.iv) }, rec.key, buf(rec.box)),
    )
  } catch {
    await deleteSessionRecord(db)
    return null
  }
  const identity = identityFromSeed(seed)
  if (identity.pub !== rec.pub) {
    await deleteSessionRecord(db)
    return null
  }
  return identity
}

/** Expiry epoch of the live session, or null (clearing an expired one). */
export async function getSessionExpiry(
  db: LawhaDb,
  now: number = Date.now(),
): Promise<number | null> {
  const rec = await getSessionRecord(db)
  if (!rec) return null
  if (rec.expiresAt <= now) {
    await deleteSessionRecord(db)
    return null
  }
  return rec.expiresAt
}

export function clearSession(db: LawhaDb): Promise<void> {
  return deleteSessionRecord(db)
}
