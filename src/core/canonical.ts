/**
 * Canonical JSON for signing/hashing. Instead of full RFC 8785 we constrain
 * the protocol schema: envelopes may contain only strings, safe integers,
 * null, and objects/arrays thereof. Anything else is rejected loudly so a
 * non-canonical value can never be signed in the first place.
 */

const encoder = new TextEncoder()

export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'string') return JSON.stringify(value)
  if (t === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`non-canonical number: ${String(value)}`)
    }
    return String(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']'
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return (
      '{' +
      keys
        .map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k]))
        .join(',') +
      '}'
    )
  }
  throw new Error(`non-canonical value of type ${t}`)
}

export function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalize(value))
}
