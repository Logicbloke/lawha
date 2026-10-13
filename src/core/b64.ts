export function toB64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array {
  const b64 =
    s.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const B64URL_RE = /^[A-Za-z0-9_-]+$/

/**
 * True when s is the canonical encoding of the bytes it decodes to. b64url
 * leaves slack bits in the final character (2 bits for 32-byte values, 4 for
 * 64-byte ones), so several strings can decode to the same bytes. Accepting a
 * non-canonical variant lets a peer re-inject an existing signed message
 * under a fresh msgId — validation must reject anything but the round-trip
 * stable form.
 */
export function isCanonicalB64url(s: string): boolean {
  if (!B64URL_RE.test(s)) return false
  try {
    return toB64url(fromB64url(s)) === s
  } catch {
    return false
  }
}

/** b64url length of a 32-byte value (pubkeys, msgIds) */
export const B64_32 = 43
/** b64url length of a 64-byte value (signatures) */
export const B64_64 = 86
/** b64url length of a 16-byte value (device ids, entity ids, epoch ids) */
export const B64_16 = 22
/** b64url length of a 24-byte value (XChaCha20 nonces) */
export const B64_24 = 32

const encoder = new TextEncoder()

export function utf8(s: string): Uint8Array {
  return encoder.encode(s)
}

/** 8-byte big-endian encoding of a safe integer, for AAD/KDF inputs. */
export function u64(n: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n))
  return out
}
