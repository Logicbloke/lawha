/**
 * What a file is, from its first bytes. An attachment's `mime` is whatever
 * its uploader's browser (or a modified client) said, so it is only a hint:
 * the only files shown inline are raster images and videos recognised here,
 * and their type comes from this, never from the op. Anything else (SVG and
 * HTML included) is only ever downloaded: a `blob:` URL shares the app's
 * origin, and a script in it could read every key.
 */

export type Sniffed =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'image/avif'
  | 'video/mp4'
  | 'video/webm'
  | 'application/pdf'

const INLINE_IMAGES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
const INLINE_VIDEOS: ReadonlySet<string> = new Set(['video/mp4', 'video/webm'])
/** what a thumbnail may be: an <img> of a data: URL typed by this sniff */
const THUMB_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp'])

export function isInlineImage(t: Sniffed | null): boolean {
  return t !== null && INLINE_IMAGES.has(t)
}

export function isInlineVideo(t: Sniffed | null): boolean {
  return t !== null && INLINE_VIDEOS.has(t)
}

export function isThumbType(t: Sniffed | null): boolean {
  return t !== null && THUMB_TYPES.has(t)
}

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x)

/** ISO-BMFF brands that are still images (HEIF), not video */
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'])
const AVIF_BRANDS = new Set(['avif', 'avis'])
/** audio-only brands (an .m4a is ISO-BMFF too) */
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A '])

export function sniff(head: Uint8Array): Sniffed | null {
  if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts(head, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'image/webp'
  if (starts(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm'
  if (ascii(head, 0, 5) === '%PDF-') return 'application/pdf'
  if (head.length >= 12 && ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12)
    if (AVIF_BRANDS.has(brand)) return 'image/avif'
    if (HEIF_BRANDS.has(brand) || AUDIO_BRANDS.has(brand)) return null
    return 'video/mp4'
  }
  return null
}

/**
 * A file name safe to offer as a download: no path separators, control
 * characters or bidi overrides (which can make `gpj.exe` read as `exe.jpg`).
 */
export function safeFileName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩/\\:*?"<>|]/g, '_').trim()
  return clean.replace(/^\.+/, '') || 'file'
}
