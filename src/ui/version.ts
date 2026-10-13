// Version comparison for the update check. Kept free of React and browser
// APIs so it is unit-testable under the node test env.

/**
 * Extract the leading `major.minor.patch` from a version string. Handles
 * plain release tags (`v0.1.0`), `git describe` output (`v0.1.0-3-gabc1234`),
 * and a bare `0.1.0`. Returns null for anything without a semver core
 * (e.g. `unknown`, a bare commit hash) so callers can fail safe.
 */
export function parseVersion(s: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/**
 * True only when `latest` is a strictly greater release than `current`.
 * Unparseable input on either side ⇒ false: we never nag on a version we
 * cannot reason about.
 */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return false
}
