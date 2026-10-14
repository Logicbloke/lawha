/**
 * Mentions live in a comment's text as `@[name](pub)`: the name it read as
 * when written, then the key it points at. Plain text, so the comment op is
 * unchanged; it is a mention by convention only (anyone can type one).
 */
const TOKEN = /@\[([^\]\n]{1,80})\]\(([A-Za-z0-9_-]{43})\)/g

export function mentionToken(name: string, pub: string): string {
  const clean = name.replace(/[\]\n]/g, ' ').trim().slice(0, 80) || pub.slice(0, 8)
  return `@[${clean}](${pub})`
}

export type Segment = { text: string } | { pub: string; name: string }

/** The text cut into plain runs and mentions, in order. */
export function splitMentions(text: string): Segment[] {
  const out: Segment[] = []
  let at = 0
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) })
    out.push({ name: m[1]!, pub: m[2]! })
    at = m.index + m[0].length
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out
}

export function mentionedPubs(text: string): Set<string> {
  return new Set([...text.matchAll(TOKEN)].map((m) => m[2]!))
}

/** The text as people read it: each mention as `@name` (`nameOf` may know a newer one). */
export function plainMentions(text: string, nameOf: (pub: string) => string | undefined = () => undefined): string {
  return text.replace(TOKEN, (_, name: string, pub: string) => `@${nameOf(pub) || name}`)
}
