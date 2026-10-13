import { ed25519 } from '@noble/curves/ed25519.js'
import { scryptAsync } from '@noble/hashes/scrypt.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { fromB64url, toB64url } from './b64'
import type { Identity, IdentityRecord, ScryptParams } from './types'

const EXPORT_PREFIX = 'lawha-key-v1:'
/** Shabaka backups hold the same Ed25519 seed, so the same identity works here. */
const SHABAKA_PREFIX = 'shabaka-key-v1:'

/** N=2^17 → ~134 MB and 1–2 s in-browser; deliberate, this key is the identity. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 }

export function identityFromSeed(seed: Uint8Array): Identity {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes')
  const pubBytes = ed25519.getPublicKey(seed)
  return { pub: toB64url(pubBytes), pubBytes, seed }
}

export function generateIdentity(): Identity {
  return identityFromSeed(randomBytes(32))
}

export function exportIdentity(identity: Identity): string {
  return EXPORT_PREFIX + toB64url(identity.seed)
}

export function importIdentity(exported: string): Identity {
  const trimmed = exported.trim()
  const prefix = [EXPORT_PREFIX, SHABAKA_PREFIX].find((p) => trimmed.startsWith(p))
  if (!prefix) throw new Error('not a lawha key backup')
  let seed: Uint8Array
  try {
    seed = fromB64url(trimmed.slice(prefix.length))
  } catch {
    throw new Error('not a lawha key backup')
  }
  if (seed.length !== 32) throw new Error('not a lawha key backup')
  return identityFromSeed(seed)
}

async function passphraseKey(
  passphrase: string,
  salt: Uint8Array,
  params: ScryptParams,
): Promise<Uint8Array> {
  return scryptAsync(passphrase, salt, { ...params, dkLen: 32 })
}

export async function toIdentityRecord(
  identity: Identity,
  passphrase?: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<IdentityRecord> {
  if (!passphrase) {
    return { id: 'self', pub: identity.pub, seed: toB64url(identity.seed) }
  }
  const salt = randomBytes(16)
  const nonce = randomBytes(24)
  const key = await passphraseKey(passphrase, salt, params)
  const box = xchacha20poly1305(key, nonce).encrypt(identity.seed)
  return {
    id: 'self',
    pub: identity.pub,
    enc: { salt: toB64url(salt), nonce: toB64url(nonce), box: toB64url(box), scrypt: params },
  }
}

export function recordNeedsPassphrase(record: IdentityRecord): boolean {
  return record.enc !== undefined
}

/** Throws on a wrong passphrase (AEAD tag failure). */
export async function unlockIdentity(
  record: IdentityRecord,
  passphrase?: string,
): Promise<Identity> {
  if (record.seed !== undefined) {
    return identityFromSeed(fromB64url(record.seed))
  }
  if (!record.enc) throw new Error('malformed identity record')
  if (!passphrase) throw new Error('passphrase required')
  const key = await passphraseKey(passphrase, fromB64url(record.enc.salt), record.enc.scrypt)
  let seed: Uint8Array
  try {
    seed = xchacha20poly1305(key, fromB64url(record.enc.nonce)).decrypt(
      fromB64url(record.enc.box),
    )
  } catch {
    throw new Error('wrong passphrase')
  }
  const identity = identityFromSeed(seed)
  if (identity.pub !== record.pub) throw new Error('wrong passphrase')
  return identity
}
