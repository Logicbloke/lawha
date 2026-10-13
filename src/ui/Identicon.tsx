import { sha256 } from '@noble/hashes/sha2.js'
import { fromB64url } from '../core/b64'

/**
 * A 5×5 mirrored pattern derived from the public key. Names can be spoofed;
 * this, with the key fingerprint beside it, is how people tell members apart.
 */
export function Identicon({ pub, size = 28 }: { pub: string; size?: number }) {
  let bytes: Uint8Array
  try {
    bytes = sha256(fromB64url(pub))
  } catch {
    bytes = new Uint8Array(32)
  }
  const hue = Math.round((bytes[0]! / 255) * 360)
  const fg = `hsl(${hue} 55% 58%)`
  const bg = `hsl(${hue} 30% 18%)`
  const cells: string[] = []
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const bit = (bytes[1 + y]! >> x) & 1
      if (!bit) continue
      cells.push(`M${x + 1} ${y + 1}h1v1h-1z`)
      if (x < 2) cells.push(`M${5 - x} ${y + 1}h1v1h-1z`)
    }
  }
  return (
    <svg className="identicon" width={size} height={size} viewBox="0 0 7 7" aria-hidden="true">
      <rect width="7" height="7" rx="1.6" fill={bg} />
      <path d={cells.join('')} fill={fg} />
    </svg>
  )
}
