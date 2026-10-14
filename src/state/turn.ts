import { getEngine } from './store'

/**
 * An optional TURN server, for networks that block direct connections
 * between devices. Kept on this device only, sealed under the install's
 * local key like the rest of what sits at rest.
 */

export interface TurnServer {
  urls: string
  username: string
  credential: string
}

const KEY = 'lawha-turn'

export const isTurnUrl = (u: string): boolean => /^turns?:[^\s/?#]+(\?transport=(udp|tcp))?$/i.test(u.trim())

function isTurnServer(x: unknown): x is TurnServer {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return typeof o.urls === 'string' && isTurnUrl(o.urls) && typeof o.username === 'string' && typeof o.credential === 'string'
}

export function loadTurn(): TurnServer | null {
  try {
    const raw = localStorage.getItem(KEY)
    const text = raw ? getEngine().openText(raw) : null
    const x: unknown = text ? JSON.parse(text) : null
    return isTurnServer(x) ? x : null
  } catch {
    return null
  }
}

/** Store (or with null, forget) the TURN server; the network must restart to use it. */
export function saveTurn(server: TurnServer | null): void {
  try {
    if (server) localStorage.setItem(KEY, getEngine().sealText(JSON.stringify({ ...server, urls: server.urls.trim() })))
    else localStorage.removeItem(KEY)
  } catch {
    // private mode: nothing kept
  }
}

/** The ICE servers new connections may use besides Trystero's STUN defaults. */
export function iceServers(): RTCIceServer[] {
  const t = loadTurn()
  return t ? [{ urls: t.urls, username: t.username, credential: t.credential }] : []
}
