import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { fromB64url, toB64url } from './b64'
import { chainKey } from './envelope'
import { MAX_UPTO } from './validate'
import {
  RANK,
  type AclContent,
  type ForkRecord,
  type OpContent,
  type Role,
  type RoleOrNone,
  type StoredMessage,
  type UpTo,
} from './types'

/**
 * Order-free resolution of a board's log set: derived Lamport clocks, each
 * envelope's causal ACL past, which ACL ops are valid, and everyone's role.
 * The result is a pure function of the stored envelope set — every peer that
 * holds the same envelopes computes the same board, whatever order they
 * arrived in.
 *
 * Rules (see README "Permissions"):
 *  - ranks: owner 3 > admin 2 > editor 1 > viewer 0 > none.
 *  - an actor may change a target only if rank(actor) > rank(target) and
 *    rank(newRole) < rank(actor), judged in the op's causal past. So only the
 *    owner changes admins, and nobody can remove the owner.
 *  - roleAt(T, C): among valid role events on T inside C, keep those not in
 *    another's causal past; the winner is max by (actor rank, most
 *    restrictive role, lowest msgId).
 *  - an op is cut when a role event it did not see (not in its causal past)
 *    lowered its author below what the op needs, unless the event's `upTo`
 *    says the actor had already seen this op. That defeats backdating: a
 *    removed member cannot write "as of before the removal" — new envelopes
 *    are past the cutoff.
 */

export interface RoleEvent {
  /** bit index of the ACL op */
  idx: number
  id: string
  actor: string
  actorRank: number
  target: string
  role: RoleOrNone
  upTo: UpTo
}

export interface DeviceInfo {
  dev: string
  seq: number
  id: string
  lastTs: number
  count: number
}

export interface Resolved {
  board: string
  owner: string | null
  genesisId: string | null
  /** resolved envelopes (not held, not past a fork) in a topological order */
  order: StoredMessage[]
  /** ids whose chain predecessor, dep or ACL refs are missing */
  held: Set<string>
  lc: Map<string, number>
  /** ACL ops by bit index */
  aclOps: StoredMessage[]
  aclIndex: Map<string, number>
  aclValid: boolean[]
  /** causal ACL past of every resolved envelope */
  past: Map<string, Uint32Array>
  /** valid role events, by target */
  events: Map<string, RoleEvent[]>
  /** current role of everyone ever named, plus the owner */
  roles: Map<string, Role>
  /** frontier of the resolved ACL ops: what a new envelope should reference */
  aclHeads: string[]
  /** highest-clock envelope: what a new envelope's `dep` should name */
  maxClockId: string | null
  /** chains by author → device */
  devices: Map<string, DeviceInfo[]>
  /** chainKey → seq → id, for cutoff checks */
  chainIds: Map<string, Map<number, string>>
}

// ---- bitsets over ACL op indices ----

function has(bs: Uint32Array, i: number): boolean {
  return (bs[i >>> 5]! & (1 << (i & 31))) !== 0
}

function withBit(bs: Uint32Array, i: number): Uint32Array {
  if (has(bs, i)) return bs
  const out = bs.slice()
  out[i >>> 5]! |= 1 << (i & 31)
  return out
}

/** OR `from` into `bs`, copying only if something changes. */
function union(bs: Uint32Array, from: Uint32Array): Uint32Array {
  let out = bs
  for (let w = 0; w < from.length; w++) {
    const add = from[w]! & ~out[w]!
    if (add !== 0) {
      if (out === bs) out = bs.slice()
      out[w]! |= add
    }
  }
  return out
}

export function boardIdFor(owner: string, nonce: string): string {
  return toB64url(sha256(concatBytes(fromB64url(owner), fromB64url(nonce))))
}

function aclOf(m: StoredMessage): AclContent {
  return m.content as AclContent
}

function refsOf(m: StoredMessage): string[] {
  return m.type === 'acl' ? aclOf(m).acl : (m.content as OpContent).acl
}

/** Which rank an ACL op needs from its author, given the target's current role. */
function aclAllowed(
  c: AclContent,
  actorRank: number,
  targetRank: number,
): boolean {
  switch (c.act) {
    case 'set-role':
      return actorRank >= RANK.admin && actorRank > targetRank && RANK[c.role] < actorRank
    case 'remove':
      return actorRank >= RANK.admin && actorRank > targetRank
    case 'rotate':
      return actorRank >= RANK.admin
    case 'leave':
      return actorRank >= RANK.viewer && actorRank < RANK.owner
    case 'genesis':
      return false
  }
}

export function resolve(
  board: string,
  messages: StoredMessage[],
  forks: ForkRecord[] = [],
): Resolved {
  // ---- forks: a proven equivocation invalidates that device from the fork on
  const forkAt = new Map<string, number>()
  for (const f of forks) {
    const k = chainKey(f)
    forkAt.set(k, Math.min(forkAt.get(k) ?? Infinity, f.seq))
  }
  const live = messages.filter(
    (m) => m.board === board && m.seq < (forkAt.get(chainKey(m)) ?? Infinity),
  )

  const byId = new Map<string, StoredMessage>()
  const chainIds = new Map<string, Map<number, string>>()
  for (const m of live) {
    byId.set(m.id, m)
    const k = chainKey(m)
    let c = chainIds.get(k)
    if (!c) chainIds.set(k, (c = new Map()))
    c.set(m.seq, m.id)
  }

  // ---- Kahn over (chain predecessor, dep, ACL refs)
  const unresolvable = new Set<string>()
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const m of live) {
    const deps = new Set<string>()
    if (m.prev !== null) deps.add(m.prev)
    if (m.dep !== null) deps.add(m.dep)
    for (const r of refsOf(m)) {
      deps.add(r)
      const target = byId.get(r)
      if (target && target.type !== 'acl') unresolvable.add(m.id) // refs must name ACL ops
    }
    let n = 0
    for (const d of deps) {
      if (!byId.has(d)) unresolvable.add(m.id)
      n++
      let list = dependents.get(d)
      if (!list) dependents.set(d, (list = []))
      list.push(m.id)
    }
    indegree.set(m.id, n)
  }

  const order: StoredMessage[] = []
  const queue: string[] = []
  for (const m of live) if (indegree.get(m.id) === 0 && !unresolvable.has(m.id)) queue.push(m.id)
  while (queue.length > 0) {
    const id = queue.pop()!
    order.push(byId.get(id)!)
    for (const d of dependents.get(id) ?? []) {
      const n = indegree.get(d)! - 1
      indegree.set(d, n)
      if (n === 0 && !unresolvable.has(d)) queue.push(d)
    }
  }
  const resolvedIds = new Set(order.map((m) => m.id))
  const held = new Set(live.filter((m) => !resolvedIds.has(m.id)).map((m) => m.id))

  // ---- clocks and causal ACL pasts, in topological order
  const nAcl = order.reduce((n, m) => n + (m.type === 'acl' ? 1 : 0), 0)
  const words = Math.ceil(nAcl / 32)
  const empty = new Uint32Array(words)
  const lc = new Map<string, number>()
  const past = new Map<string, Uint32Array>()
  const aclOps: StoredMessage[] = []
  const aclIndex = new Map<string, number>()
  let maxClockId: string | null = null
  let maxClock = 0

  for (const m of order) {
    const clock = 1 + Math.max(m.prev ? lc.get(m.prev)! : 0, m.dep ? lc.get(m.dep)! : 0)
    lc.set(m.id, clock)
    if (clock > maxClock || (clock === maxClock && maxClockId !== null && m.id > maxClockId)) {
      maxClock = clock
      maxClockId = m.id
    }

    let p = m.prev ? past.get(m.prev)! : empty
    if (m.prev && aclIndex.has(m.prev)) p = withBit(p, aclIndex.get(m.prev)!)
    for (const r of refsOf(m)) {
      p = union(p, past.get(r)!)
      p = withBit(p, aclIndex.get(r)!)
    }
    past.set(m.id, p)
    if (m.type === 'acl') {
      aclIndex.set(m.id, aclOps.length)
      aclOps.push(m)
    }
  }

  // ---- genesis: lowest-msgId self-certifying genesis
  let genesis: StoredMessage | null = null
  for (const m of aclOps) {
    const c = aclOf(m)
    if (c.act !== 'genesis' || boardIdFor(m.author, c.nonce) !== board) continue
    if (!genesis || m.id < genesis.id) genesis = m
  }
  const owner = genesis?.author ?? null
  const genesisIdx = genesis ? aclIndex.get(genesis.id)! : -1

  // ---- role events and ACL validity
  const events = new Map<string, RoleEvent[]>()
  const aclValid: boolean[] = new Array(aclOps.length).fill(false)

  const roleAt = (target: string, c: Uint32Array): RoleOrNone => {
    if (target === owner) return 'owner'
    const evs = (events.get(target) ?? []).filter((e) => has(c, e.idx))
    let best: RoleEvent | null = null
    for (const e of evs) {
      // frontier: drop events another event in the set already saw
      if (evs.some((o) => o !== e && has(past.get(o.id)!, e.idx))) continue
      if (
        !best ||
        e.actorRank > best.actorRank ||
        (e.actorRank === best.actorRank &&
          (RANK[e.role] < RANK[best.role] || (RANK[e.role] === RANK[best.role] && e.id < best.id)))
      )
        best = e
    }
    return best ? best.role : 'none'
  }

  /** Did the actor of a cutoff already see envelope m? */
  const covered = (m: StoredMessage, upTo: UpTo): boolean => {
    const cut = upTo[m.dev]
    if (!cut || m.seq > cut[0]) return false
    return chainIds.get(chainKey(m))?.get(cut[0]) === cut[1]
  }

  const eventOf = (m: StoredMessage, idx: number, actorRank: number): RoleEvent | null => {
    const c = aclOf(m)
    const base = { idx, id: m.id, actor: m.author, actorRank }
    switch (c.act) {
      case 'set-role':
        return { ...base, target: c.target, role: c.role, upTo: c.upTo }
      case 'remove':
        return { ...base, target: c.target, role: 'none', upTo: c.upTo }
      case 'leave':
        return { ...base, target: m.author, role: 'none', upTo: c.upTo }
      default:
        return null
    }
  }

  // Owner events are valid on local checks alone, so ACL cutoffs (which only
  // the owner can impose on admins) never depend on evaluation order.
  const ownerEvents = new Map<string, RoleEvent[]>()
  if (genesis) {
    for (const m of aclOps) {
      const idx = aclIndex.get(m.id)!
      if (m.author !== owner || m === genesis || !has(past.get(m.id)!, genesisIdx)) continue
      const ev = eventOf(m, idx, RANK.owner)
      if (ev && ev.target !== owner && aclOf(m).act !== 'leave') {
        let list = ownerEvents.get(ev.target)
        if (!list) ownerEvents.set(ev.target, (list = []))
        list.push(ev)
      }
    }
  }

  for (const m of aclOps) {
    const idx = aclIndex.get(m.id)!
    const c = aclOf(m)
    if (!genesis) break
    if (c.act === 'genesis') {
      aclValid[idx] = m === genesis
      continue
    }
    const p = past.get(m.id)!
    if (!has(p, genesisIdx)) continue

    const actorRank = RANK[roleAt(m.author, p)]
    const target = c.act === 'set-role' || c.act === 'remove' ? c.target : m.author
    if ((c.act === 'set-role' || c.act === 'remove') && target === owner) continue
    const targetRank = RANK[roleAt(target, p)]
    if (!aclAllowed(c, actorRank, targetRank)) continue

    // cut by an owner event this op did not see
    const cut = (ownerEvents.get(m.author) ?? []).some(
      (r) =>
        !has(p, r.idx) && !aclAllowed(c, RANK[r.role], targetRank) && !covered(m, r.upTo),
    )
    if (cut) continue

    aclValid[idx] = true
    const ev = eventOf(m, idx, actorRank)
    if (ev) {
      let list = events.get(ev.target)
      if (!list) events.set(ev.target, (list = []))
      list.push(ev)
    }
  }

  // ---- current roles over everything
  const all = new Uint32Array(words)
  for (let i = 0; i < aclOps.length; i++) all[i >>> 5]! |= 1 << (i & 31)
  const roles = new Map<string, Role>()
  if (owner) roles.set(owner, 'owner')
  for (const target of events.keys()) {
    const r = roleAt(target, all)
    if (r !== 'none') roles.set(target, r)
  }

  // ---- ACL frontier
  let seen: Uint32Array = new Uint32Array(words)
  for (const m of aclOps) seen = union(seen, past.get(m.id)!)
  const aclHeads = aclOps
    .filter((m) => !has(seen, aclIndex.get(m.id)!))
    .map((m) => m.id)
    .sort()

  // ---- devices
  const devices = new Map<string, DeviceInfo[]>()
  const perChain = new Map<string, DeviceInfo>()
  for (const m of live) {
    const k = chainKey(m)
    const d = perChain.get(k)
    if (!d) {
      perChain.set(k, { dev: m.dev, seq: m.seq, id: m.id, lastTs: m.ts, count: 1 })
    } else {
      d.count++
      if (m.seq > d.seq) Object.assign(d, { seq: m.seq, id: m.id, lastTs: m.ts })
    }
  }
  for (const [k, d] of perChain) {
    const author = k.slice(0, k.indexOf('.'))
    let list = devices.get(author)
    if (!list) devices.set(author, (list = []))
    list.push(d)
  }

  return {
    board,
    owner,
    genesisId: genesis?.id ?? null,
    order,
    held,
    lc,
    aclOps,
    aclIndex,
    aclValid,
    past,
    events,
    roles,
    aclHeads,
    maxClockId,
    devices,
    chainIds,
  }
}

/** A role, given the resolved board; 'none' if not a member. */
export function roleOf(res: Resolved, pub: string): RoleOrNone {
  return res.roles.get(pub) ?? 'none'
}

/**
 * May this content envelope act at `required` rank? Both the author's role in
 * the envelope's own causal past and the role once every unseen, uncovered
 * restriction is applied must reach it.
 */
export function canWrite(res: Resolved, m: StoredMessage, required: number): boolean {
  const p = res.past.get(m.id)
  if (!p || res.owner === null || res.genesisId === null) return false
  const gIdx = res.aclIndex.get(res.genesisId)!
  if (!has(p, gIdx)) return false
  if (m.author === res.owner) return true

  const evs = res.events.get(m.author) ?? []
  const roleIn = (c: Uint32Array): RoleOrNone => {
    const inC = evs.filter((e) => has(c, e.idx))
    let best: RoleEvent | null = null
    for (const e of inC) {
      if (inC.some((o) => o !== e && has(res.past.get(o.id)!, e.idx))) continue
      if (
        !best ||
        e.actorRank > best.actorRank ||
        (e.actorRank === best.actorRank &&
          (RANK[e.role] < RANK[best.role] || (RANK[e.role] === RANK[best.role] && e.id < best.id)))
      )
        best = e
    }
    return best ? best.role : 'none'
  }

  if (RANK[roleIn(p)] < required) return false

  let widened: Uint32Array = p
  for (const r of evs) {
    if (has(p, r.idx) || RANK[r.role] >= required) continue
    const cut = r.upTo[m.dev]
    const seen = cut && m.seq <= cut[0] && res.chainIds.get(chainKey(m))?.get(cut[0]) === cut[1]
    if (seen) continue
    widened = union(withBit(widened, r.idx), res.past.get(r.id)!)
  }
  return widened === p || RANK[roleIn(widened)] >= required
}

/** Cutoff for a member about to lose rights: what we have seen of each device. */
export function upToFor(res: Resolved, target: string): UpTo {
  const devs = [...(res.devices.get(target) ?? [])]
    .sort((a, b) => b.count - a.count || (a.dev < b.dev ? -1 : 1))
    .slice(0, MAX_UPTO)
  const out: UpTo = {}
  for (const d of devs) out[d.dev] = [d.seq, d.id]
  return out
}

export function isAclValid(res: Resolved, id: string): boolean {
  const idx = res.aclIndex.get(id)
  return idx !== undefined && res.aclValid[idx]!
}

/** Is ACL op `a` in the causal past of envelope `id`? */
export function inPast(res: Resolved, id: string, a: string): boolean {
  const p = res.past.get(id)
  const idx = res.aclIndex.get(a)
  return !!p && idx !== undefined && has(p, idx)
}
