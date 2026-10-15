import { create } from 'zustand'
import { fromB64url } from '../core/b64'
import type { Engine } from '../core/engine'

/**
 * Our own other devices. An install of our key is offered our boards only
 * once allowed here, asked the first time it connects with something to
 * take (Engine.approvedDevice). Each device shows its code so the person can
 * tell theirs from someone who has the key. Kept on this device only.
 */

const KEY = 'lawha:devices'
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function load(): Set<string> {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    return new Set(Array.isArray(list) ? list.filter((d): d is string => typeof d === 'string') : [])
  } catch {
    return new Set()
  }
}

const approved = load()
/** put off until the app restarts */
const dismissed = new Set<string>()

/** installs of our key asking for our boards right now */
export const useWaitingDevices = create<string[]>(() => [])

/** A device's code, as both it and the device asked about show it: 8 letters from its id. */
export function deviceCode(dev: string): string {
  const bytes = fromB64url(dev)
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes.subarray(0, 5)) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`
}

let engine: Engine | null = null

function refresh(): void {
  if (!engine) return
  const list = engine.sync.waitingDevices().filter((d) => !dismissed.has(d))
  const prev = useWaitingDevices.getState()
  if (list.length !== prev.length || list.some((d, i) => d !== prev[i])) useWaitingDevices.setState(list, true)
}

export function approveDevice(dev: string): void {
  approved.add(dev)
  try {
    localStorage.setItem(KEY, JSON.stringify([...approved]))
  } catch {
    // not persisted: it still holds until the app restarts
  }
  engine?.sync.reoffer()
  refresh()
}

export function dismissDevice(dev: string): void {
  dismissed.add(dev)
  refresh()
}

/** Before the network starts: no board goes to one of our devices before this. */
export function startDevices(e: Engine): void {
  if (engine) return
  engine = e
  e.approvedDevice = (dev) => approved.has(dev)
  e.events.on('device-waiting', refresh)
  e.events.on('presence', refresh)
}
