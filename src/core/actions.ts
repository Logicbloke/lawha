
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, randomBytes } from '@noble/hashes/utils.js'
import { fromB64url, toB64url } from './b64'
import { boardIdFor, upToFor } from './acl'
import { createEpoch, createGrant, sealOp, type KeyRing } from './boardcrypto'
import {
  MAX_MOVES,
  freshPositions,
  needsRenormalize,
  positionsAt,
  type BoardOp,
  type BoardView,
  type Card,
} from './board'
import type { AppendItem } from './log'
import { MAX_CARRIED_KEYS } from './validate'
import { RANK, type BoardKind, type Identity, type OpContent, type Role } from './types'

/**
 * Builders for every write. They read the current BoardView (ACL heads, the
 * writer key, roles) and return AppendItems for log.appendBatch, which signs
 * them atomically. Authorization is enforced by every receiver's fold; these
 * only refuse what would obviously be rejected, so users get an error
 * instead of a silently ignored edit.
 */

export class ActionError extends Error {}

/** Content op under the current writer epoch. */
export function opItem(view: BoardView, op: BoardOp): AppendItem {
  const epoch = view.writerEpoch
  if (!epoch) throw new ActionError('no board key')
  if (view.aclHeads.length === 0) throw new ActionError('board not synced')
  const acl = view.aclHeads.slice(0, 32)
  return {
    board: view.id,
    type: 'op',
    dep: view.maxClockId,
    build: ({ board, author, dev, seq }): OpContent => {
      const { n, box } = sealOp(epoch.key, { board, author, dev, seq, epoch: epoch.id }, op)
      return { acl, epoch: epoch.id, n, box }
    },
  }
}

export interface NewBoard {
  id: string
  items: AppendItem[]
}

/**
 * Genesis plus the starter content, as one batch: the board name, the
 * creator's display name and default columns, all encrypted under the
 * genesis epoch key.
 */
export function createBoardItems(
  me: Identity,
  opts: { kind: BoardKind; ws: string | null; name: string; myName: string; columns: string[] },
): NewBoard {
  const nonce = toB64url(randomBytes(16))
  const id = boardIdFor(me.pub, nonce)
  const { blob, key } = createEpoch(id, [me.pub], new Map())
  const genesis: AppendItem = {
    board: id,
    type: 'acl',
    dep: null,
    build: () => ({ act: 'genesis', acl: [], nonce, kind: opts.kind, ws: opts.ws, epoch: blob }),
  }
  const positions = freshPositions(opts.columns.length)
  const ops: BoardOp[] = [
    { k: 'board.update', name: opts.name },
    ...(opts.myName ? [{ k: 'profile.set' as const, name: opts.myName }] : []),
    ...opts.columns.map((name, i) => ({
      k: 'column.create' as const,
      id: newEntityId(),
      name,
      pos: positions[i]!,
    })),
  ]
  const contentItems = ops.map(
    (op): AppendItem => ({
      board: id,
      type: 'op',
      dep: null,
      build: ({ board, author, dev, seq, prior }): OpContent => {
        const g = prior[0]!
        const { n, box } = sealOp(key, { board, author, dev, seq, epoch: blob.id }, op)
        return { acl: [g.id], epoch: blob.id, n, box }
      },
    }),
  )
  return { id, items: [genesis, ...contentItems] }
}

export function newEntityId(): string {
  return toB64url(randomBytes(16))
}

/** Same source card moved to the same board twice → same target card. */
export function movedCardId(srcBoard: string, srcCard: string, dstBoard: string): string {
  const h = sha256(concatBytes(fromB64url(srcBoard), fromB64url(srcCard), fromB64url(dstBoard)))
  return toB64url(h.subarray(0, 16))
}

/** Keys of the epoch heads we hold: what a new epoch carries / a grant hands over. */
function headKeys(view: BoardView): KeyRing {
  // carry every key no known epoch already carries: walking `prev` from the
  // new key then reaches all history, whatever its validity
  const carried = new Set<string>()
  for (const m of view.resolved.aclOps) {
    const c = m.content
    if ('epoch' in c && typeof c.epoch === 'object') for (const pid of Object.keys(c.epoch.prev)) carried.add(pid)
  }
  const heads = [...view.keys].filter(([id]) => !carried.has(id))
  heads.sort(([a], [b]) => (view.epochs.get(b)?.opId ?? '').localeCompare(view.epochs.get(a)?.opId ?? ''))
  return new Map(heads.slice(0, MAX_CARRIED_KEYS))
}

function aclRefs(view: BoardView): string[] {
  if (view.aclHeads.length === 0) throw new ActionError('board not synced')
  return view.aclHeads.slice(0, 32)
}

function roleRank(view: BoardView, pub: string): number {
  return RANK[view.members.find((m) => m.pub === pub)?.role ?? 'none']
}

/** Add a member or change a role. New members get every current key. */
export function setRoleItem(view: BoardView, me: Identity, target: string, role: Exclude<Role, 'owner'>): AppendItem {
  const myRank = RANK[view.myRole]
  const targetRank = roleRank(view, target)
  if (target === me.pub || target === view.owner) throw new ActionError('not allowed')
  if (!(myRank >= RANK.admin && myRank > targetRank && RANK[role] < myRank)) throw new ActionError('not allowed')
  const downgrade = targetRank >= 0 && RANK[role] < targetRank
  const isNew = targetRank < 0
  const acl = aclRefs(view)
  const upTo = downgrade ? upToFor(view.resolved, target) : {}
  const grant = isNew ? createGrant(view.id, target, headKeys(view)) : null
  return {
    board: view.id,
    type: 'acl',
    dep: view.maxClockId,
    build: () => ({ act: 'set-role', acl, target, role, upTo, grant }),
  }
}

/** Remove a member and rotate to a key they never see. */
export function removeItem(view: BoardView, me: Identity, target: string): AppendItem {
  const myRank = RANK[view.myRole]
  const targetRank = roleRank(view, target)
  if (target === me.pub || target === view.owner) throw new ActionError('not allowed')
  if (!(myRank >= RANK.admin && myRank > targetRank)) throw new ActionError('not allowed')
  const acl = aclRefs(view)
  const upTo = upToFor(view.resolved, target)
  const recipients = view.members.map((m) => m.pub).filter((p) => p !== target)
  const { blob } = createEpoch(view.id, recipients, headKeys(view))
  return {
    board: view.id,
    type: 'acl',
    dep: view.maxClockId,
    build: () => ({ act: 'remove', acl, target, upTo, epoch: blob }),
  }
}

/** Leave a board. An admin's client rotates the key afterwards (heal). */
export function leaveItem(view: BoardView, me: Identity): AppendItem {
  if (view.myRole === 'owner' || view.myRole === 'none') throw new ActionError('not allowed')
  const acl = aclRefs(view)
  const upTo = upToFor(view.resolved, me.pub)
  return {
    board: view.id,
    type: 'acl',
    dep: view.maxClockId,
    build: () => ({ act: 'leave', acl, upTo }),
  }
}

/** Fresh key for exactly the current members, carrying all heads we hold. */
export function rotateItem(view: BoardView): AppendItem {
  if (RANK[view.myRole] < RANK.admin) throw new ActionError('not allowed')
  const acl = aclRefs(view)
  const { blob } = createEpoch(
    view.id,
    view.members.map((m) => m.pub),
    headKeys(view),
  )
  return {
    board: view.id,
    type: 'acl',
    dep: view.maxClockId,
    build: () => ({ act: 'rotate', acl, epoch: blob }),
  }
}

// ---- moving cards ----

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/**
 * Move cards (one or a whole selection, in the given order) into `col` at
 * `index` of that column as it would look without them. Large groups become
 * several ops in one batch.
 */
export function moveCardsItems(view: BoardView, ids: string[], col: string, index: number): AppendItem[] {
  if (!view.byColumn.has(col)) throw new ActionError('no such column')
  const moving = new Set(ids)
  const rest = view.byColumn.get(col)!.filter((c) => !moving.has(c.id))
  const at = Math.max(0, Math.min(index, rest.length))
  const sorted = rest.map((c) => c.pos)
  const ops: BoardOp[] = []
  if (needsRenormalize(sorted)) {
    // keys grew long: lay the whole column out again around the moved cards
    const all = [...rest.slice(0, at).map((c) => c.id), ...ids, ...rest.slice(at).map((c) => c.id)]
    const fresh = freshPositions(all.length)
    for (const part of chunk(all.map((id, i) => ({ id, col, pos: fresh[i]! })), MAX_MOVES)) {
      ops.push({ k: 'card.move', moves: part })
    }
    return ops.map((op) => opItem(view, op))
  }
  const positions = positionsAt(sorted, at, ids.length)
  for (const part of chunk(ids.map((id, i) => ({ id, col, pos: positions[i]! })), MAX_MOVES)) {
    ops.push({ k: 'card.move', moves: part })
  }
  return ops.map((op) => opItem(view, op))
}

/** Reorder a column to `index` among the live columns. */
export function moveColumnItem(view: BoardView, colId: string, index: number): AppendItem {
  const rest = view.columns.filter((c) => c.id !== colId)
  const at = Math.max(0, Math.min(index, rest.length))
  const pos = positionsAt(rest.map((c) => c.pos), at, 1)[0]!
  return opItem(view, { k: 'column.update', id: colId, pos })
}

export interface CrossMove {
  items: AppendItem[]
  /** source card id → target card id */
  mapping: Map<string, string>
}

/**
 * Move cards to another board: create them there (deterministic ids, so two
 * people moving the same card to the same board end up with one card), carry
 * labels by name and comments as imported snapshots, then stub them out in
 * the source. One batch: all of it lands or none does.
 */
export function moveCardsToBoardItems(
  src: BoardView,
  dst: BoardView,
  ids: string[],
  dstCol: string,
  index: number,
): CrossMove {
  if (src.id === dst.id) throw new ActionError('same board')
  if (!dst.byColumn.has(dstCol)) throw new ActionError('no such column')
  if (RANK[src.myRole] < RANK.editor || RANK[dst.myRole] < RANK.editor) throw new ActionError('not allowed')
  const cards = ids
    .map((id) => src.cards.get(id))
    .filter((c): c is Card => c !== undefined && c.movedTo === null)
  if (cards.length === 0) throw new ActionError('nothing to move')

  const dstMembers = new Set(dst.members.map((m) => m.pub))
  const dstLabelsByName = new Map<string, string>()
  for (const l of dst.labels.values()) if (!l.archived) dstLabelsByName.set(l.name.toLowerCase(), l.id)

  const targetOps: BoardOp[] = []
  const labelFor = (srcLabelId: string): string | null => {
    const l = src.labels.get(srcLabelId)
    if (!l || l.archived) return null
    const key = l.name.toLowerCase()
    let id = dstLabelsByName.get(key)
    if (!id) {
      id = movedCardId(src.id, l.id, dst.id)
      dstLabelsByName.set(key, id)
      targetOps.push({ k: 'label.set', id, name: l.name, color: l.color, archived: false })
    }
    return id
  }

  const sorted = (dst.byColumn.get(dstCol) ?? []).map((c) => c.pos)
  const positions = positionsAt(sorted, Math.max(0, Math.min(index, sorted.length)), cards.length)
  const mapping = new Map<string, string>()
  const commentOps: BoardOp[] = []
  cards.forEach((card, i) => {
    const newId = movedCardId(src.id, card.id, dst.id)
    mapping.set(card.id, newId)
    targetOps.push({
      k: 'card.create',
      id: newId,
      col: dstCol,
      pos: positions[i]!,
      title: card.title,
      desc: card.desc,
      labels: card.labels.map(labelFor).filter((l): l is string => l !== null),
      assignees: card.assignees.filter((p) => dstMembers.has(p)),
      due: card.due,
      from: { board: src.id, card: card.id },
    })
    for (const cm of card.comments) {
      commentOps.push({
        k: 'comment.add',
        id: movedCardId(src.id, cm.id, dst.id),
        card: newId,
        text: cm.text,
        imported: cm.imported ?? { author: cm.author, name: src.profiles.get(cm.author) ?? '', ts: cm.ts },
      })
    }
  })

  const items = [...targetOps, ...commentOps].map((op) => opItem(dst, op))
  for (const part of chunk(cards, MAX_MOVES)) {
    items.push(
      opItem(src, { k: 'card.moveOut', ids: part.map((c) => c.id), to: dst.id, vers: part.map((c) => c.version) }),
    )
  }
  return { items, mapping }
}
