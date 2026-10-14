import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'
import { B64_16, B64_32, fromB64url, isCanonicalB64url, toB64url, utf8 } from './b64'
import { canWrite, isAclValid, resolve, type Resolved } from './acl'
import {
  keyCommitment,
  openCarried,
  openEpoch,
  openGrant,
  openOp,
  type KeyRing,
} from './boardcrypto'
import {
  RANK,
  type AclContent,
  type BoardKind,
  type EpochBlob,
  type ForkRecord,
  type Identity,
  type OpContent,
  type Role,
  type RoleOrNone,
  type StoredMessage,
} from './types'

// ---- op schema (the plaintext inside an encrypted content envelope) ----

export const MAX_TITLE = 200
export const MAX_DESC = 5000
export const MAX_NAME = 80
export const MAX_COMMENT = 4000
export const MAX_REFS = 20
export const MAX_MOVES = 50
export const MAX_POS = 64
/** renormalize a column once any key grows past this */
export const RENORMALIZE_POS = 48
export const LABEL_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const
export type LabelColor = (typeof LABEL_COLORS)[number]
export const MAX_FIELD_TEXT = 1000
export const MAX_URL = 2000
export const MAX_OPTIONS = 50
export const FIELD_TYPES = ['text', 'number', 'url', 'date', 'choice', 'checkbox', 'person'] as const
export type FieldType = (typeof FIELD_TYPES)[number]

export interface FieldOption {
  id: string
  name: string
  color: LabelColor
}

/** null is an entry with no value yet (or one its field's type no longer accepts) */
export type FieldValue = string | number | boolean | null

export interface Move {
  id: string
  col: string
  pos: string
}

export type BoardOp =
  | { k: 'board.update'; name?: string; desc?: string }
  | { k: 'label.set'; id: string; name: string; color: LabelColor; archived: boolean }
  | { k: 'profile.set'; name: string }
  | { k: 'column.create'; id: string; name: string; pos: string }
  | { k: 'column.update'; id: string; name?: string; pos?: string; wip?: number | null; archived?: boolean }
  | {
      k: 'card.create'
      id: string
      col: string
      pos: string
      title: string
      desc: string
      labels: string[]
      assignees: string[]
      due: string | null
      from: { board: string; card: string } | null
    }
  | {
      k: 'card.update'
      id: string
      title?: string
      desc?: string
      labels?: string[]
      assignees?: string[]
      due?: string | null
      archived?: boolean
    }
  | { k: 'card.move'; moves: Move[] }
  /** `vers[i]`: the edit-set version of `ids[i]` the mover copied (see Card.version) */
  | { k: 'card.moveOut'; ids: string[]; to: string; vers: string[] }
  | {
      k: 'comment.add'
      id: string
      card: string
      text: string
      imported: { author: string; name: string; ts: number } | null
    }
  /** a field template cards can use; its type is fixed by the first write */
  | { k: 'field.set'; id: string; name: string; type: FieldType; options: FieldOption[]; archived: boolean }
  /** one value on a card: a card may hold any number of entries of the same field */
  | { k: 'entry.set'; id: string; card: string; field: string; value: FieldValue; removed: boolean }
  /** workspaces: a category company boards are grouped under in everyone's sidebar */
  | { k: 'category.set'; id: string; name: string; pos: string; archived: boolean }
  /** workspaces: put a company board in a category (null: back to the main list) */
  | { k: 'board.place'; board: string; category: string | null }

export type BoardOpKind = BoardOp['k']

export function requiredRank(op: BoardOp): number {
  if (op.k === 'profile.set') return RANK.viewer
  if (op.k === 'board.update' || op.k === 'field.set' || op.k === 'category.set' || op.k === 'board.place') {
    return RANK.admin
  }
  return RANK.editor
}

const isStr = (s: unknown, max: number, min = 0): s is string =>
  typeof s === 'string' && s.length >= min && s.length <= max
const isId = (s: unknown): s is string =>
  typeof s === 'string' && s.length === B64_16 && isCanonicalB64url(s)
const isPub = (s: unknown): s is string =>
  typeof s === 'string' && s.length === B64_32 && isCanonicalB64url(s)
const isBool = (b: unknown): b is boolean => typeof b === 'boolean'
const isDue = (d: unknown): boolean => d === null || (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
const isIdList = (x: unknown, check: (s: unknown) => boolean): boolean =>
  Array.isArray(x) && x.length <= MAX_REFS && x.every(check) && new Set(x).size === x.length

const isOptions = (x: unknown): boolean =>
  Array.isArray(x) &&
  x.length <= MAX_OPTIONS &&
  x.every(
    (o: unknown) =>
      typeof o === 'object' &&
      o !== null &&
      allowedKeys(o as Record<string, unknown>, ['id', 'name', 'color']) &&
      isId((o as FieldOption).id) &&
      isStr((o as FieldOption).name, MAX_NAME, 1) &&
      LABEL_COLORS.includes((o as FieldOption).color),
  ) &&
  new Set(x.map((o: FieldOption) => o.id)).size === x.length
const isFieldValue = (v: unknown): boolean =>
  v === null || isBool(v) || (typeof v === 'number' && Number.isFinite(v)) || isStr(v, MAX_URL)

/**
 * An http(s) link with a host, and no whitespace, control characters or
 * `user@` part (a phishing staple). A pattern, not `new URL()`: browsers'
 * parsers disagree (Chromium accepts spaces in a host), and validity feeds
 * the fold, which every peer must compute alike.
 */
const HTTP_URL = /^https?:\/\/[^\s\x00-\x1f\x7f/?#@\\<>"'`{}|^]+(?:[/?#][^\s\x00-\x1f\x7f<>"]*)?$/i

export function isHttpUrl(s: string): boolean {
  return HTTP_URL.test(s)
}

/** Whether `v` is a value of `def`'s type. Decided in the fold, where the type is known. */
export function fieldValueOk(def: FieldDef, v: FieldValue): boolean {
  if (v === null) return true
  switch (def.type) {
    case 'text':
      return isStr(v, MAX_FIELD_TEXT, 1)
    case 'number':
      return typeof v === 'number'
    case 'url':
      return isStr(v, MAX_URL, 1) && isHttpUrl(v)
    case 'date':
      return typeof v === 'string' && isDue(v)
    case 'choice':
      return typeof v === 'string' && def.options.some((o) => o.id === v)
    case 'checkbox':
      return isBool(v)
    case 'person':
      return isPub(v)
  }
}

export function isPos(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_POS) return false
  try {
    generateKeyBetween(p, null) // throws on a malformed key
    return true
  } catch {
    return false
  }
}

function allowedKeys(o: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k))
}

/** Validate an op decrypted from the network; null when it is acceptable. */
export function opSchemaError(x: unknown): string | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return 'not an object'
  const o = x as Record<string, unknown>
  switch (o.k) {
    case 'board.update':
      return allowedKeys(o, ['k', 'name', 'desc']) &&
        (o.name === undefined || isStr(o.name, MAX_NAME, 1)) &&
        (o.desc === undefined || isStr(o.desc, MAX_DESC))
        ? null
        : 'bad board.update'
    case 'label.set':
      return allowedKeys(o, ['k', 'id', 'name', 'color', 'archived']) &&
        isId(o.id) &&
        isStr(o.name, MAX_NAME) &&
        LABEL_COLORS.includes(o.color as LabelColor) &&
        isBool(o.archived)
        ? null
        : 'bad label.set'
    case 'profile.set':
      return allowedKeys(o, ['k', 'name']) && isStr(o.name, MAX_NAME) ? null : 'bad profile.set'
    case 'column.create':
      return allowedKeys(o, ['k', 'id', 'name', 'pos']) &&
        isId(o.id) &&
        isStr(o.name, MAX_NAME, 1) &&
        isPos(o.pos)
        ? null
        : 'bad column.create'
    case 'column.update':
      return allowedKeys(o, ['k', 'id', 'name', 'pos', 'wip', 'archived']) &&
        isId(o.id) &&
        (o.name === undefined || isStr(o.name, MAX_NAME, 1)) &&
        (o.pos === undefined || isPos(o.pos)) &&
        (o.wip === undefined ||
          o.wip === null ||
          (Number.isSafeInteger(o.wip) && (o.wip as number) >= 1 && (o.wip as number) <= 999)) &&
        (o.archived === undefined || isBool(o.archived))
        ? null
        : 'bad column.update'
    case 'card.create': {
      const from = o.from as Record<string, unknown> | null
      return allowedKeys(o, ['k', 'id', 'col', 'pos', 'title', 'desc', 'labels', 'assignees', 'due', 'from']) &&
        isId(o.id) &&
        isId(o.col) &&
        isPos(o.pos) &&
        isStr(o.title, MAX_TITLE, 1) &&
        isStr(o.desc, MAX_DESC) &&
        isIdList(o.labels, isId) &&
        isIdList(o.assignees, isPub) &&
        isDue(o.due) &&
        (from === null ||
          (typeof from === 'object' && allowedKeys(from, ['board', 'card']) && isPub(from.board) && isId(from.card)))
        ? null
        : 'bad card.create'
    }
    case 'card.update':
      return allowedKeys(o, ['k', 'id', 'title', 'desc', 'labels', 'assignees', 'due', 'archived']) &&
        isId(o.id) &&
        (o.title === undefined || isStr(o.title, MAX_TITLE, 1)) &&
        (o.desc === undefined || isStr(o.desc, MAX_DESC)) &&
        (o.labels === undefined || isIdList(o.labels, isId)) &&
        (o.assignees === undefined || isIdList(o.assignees, isPub)) &&
        (o.due === undefined || isDue(o.due)) &&
        (o.archived === undefined || isBool(o.archived))
        ? null
        : 'bad card.update'
    case 'card.move':
      return allowedKeys(o, ['k', 'moves']) &&
        Array.isArray(o.moves) &&
        o.moves.length >= 1 &&
        o.moves.length <= MAX_MOVES &&
        o.moves.every(
          (m: unknown) =>
            typeof m === 'object' &&
            m !== null &&
            allowedKeys(m as Record<string, unknown>, ['id', 'col', 'pos']) &&
            isId((m as Move).id) &&
            isId((m as Move).col) &&
            isPos((m as Move).pos),
        )
        ? null
        : 'bad card.move'
    case 'card.moveOut':
      return allowedKeys(o, ['k', 'ids', 'to', 'vers']) &&
        Array.isArray(o.ids) &&
        o.ids.length >= 1 &&
        o.ids.length <= MAX_MOVES &&
        o.ids.every(isId) &&
        Array.isArray(o.vers) &&
        o.vers.length === o.ids.length &&
        o.vers.every(isId) &&
        isPub(o.to)
        ? null
        : 'bad card.moveOut'
    case 'comment.add': {
      const imp = o.imported as Record<string, unknown> | null
      return allowedKeys(o, ['k', 'id', 'card', 'text', 'imported']) &&
        isId(o.id) &&
        isId(o.card) &&
        isStr(o.text, MAX_COMMENT, 1) &&
        (imp === null ||
          (typeof imp === 'object' &&
            allowedKeys(imp, ['author', 'name', 'ts']) &&
            isPub(imp.author) &&
            isStr(imp.name, MAX_NAME) &&
            Number.isSafeInteger(imp.ts)))
        ? null
        : 'bad comment.add'
    }
    case 'field.set':
      return allowedKeys(o, ['k', 'id', 'name', 'type', 'options', 'archived']) &&
        isId(o.id) &&
        isStr(o.name, MAX_NAME, 1) &&
        FIELD_TYPES.includes(o.type as FieldType) &&
        isOptions(o.options) &&
        isBool(o.archived)
        ? null
        : 'bad field.set'
    case 'entry.set':
      return allowedKeys(o, ['k', 'id', 'card', 'field', 'value', 'removed']) &&
        isId(o.id) &&
        isId(o.card) &&
        isId(o.field) &&
        isFieldValue(o.value) &&
        isBool(o.removed)
        ? null
        : 'bad entry.set'
    case 'category.set':
      return allowedKeys(o, ['k', 'id', 'name', 'pos', 'archived']) &&
        isId(o.id) &&
        isStr(o.name, MAX_NAME, 1) &&
        isPos(o.pos) &&
        isBool(o.archived)
        ? null
        : 'bad category.set'
    case 'board.place':
      return allowedKeys(o, ['k', 'board', 'category']) && isPub(o.board) && (o.category === null || isId(o.category))
        ? null
        : 'bad board.place'
    default:
      return 'unknown op'
  }
}

// ---- derived board view ----

export interface Column {
  id: string
  name: string
  pos: string
  wip: number | null
  archived: boolean
}

export interface Label {
  id: string
  name: string
  color: LabelColor
  archived: boolean
}

export interface FieldDef {
  id: string
  name: string
  type: FieldType
  options: FieldOption[]
  archived: boolean
}

export interface FieldEntry {
  id: string
  field: string
  value: FieldValue
}

export interface Category {
  id: string
  name: string
  pos: string
  archived: boolean
}

export interface Comment {
  id: string
  card: string
  author: string
  text: string
  ts: number
  imported: { author: string; name: string; ts: number } | null
}

export interface Card {
  id: string
  title: string
  desc: string
  labels: string[]
  assignees: string[]
  due: string | null
  archived: boolean
  col: string
  pos: string
  /** set when the card was moved to another board; the card here is a stub */
  movedTo: string | null
  from: { board: string; card: string } | null
  createdBy: string
  createdAt: number
  updatedAt: number
  comments: Comment[]
  /** values of live fields, in the order they were added */
  fields: FieldEntry[]
  /** someone edited the card in a way the mover did not see; that edit is not in the copy */
  editedAfterMove: boolean
  /** hash of the set of edit envelopes applied to this card */
  version: string
}

export interface Member {
  pub: string
  role: Role
  name: string
  devices: Array<{ dev: string; seq: number; lastTs: number; count: number }>
}

export interface EpochInfo {
  id: string
  opId: string
  valid: boolean
  recipients: Set<string>
}

export interface BoardStats {
  /** envelopes waiting on a missing predecessor/dependency */
  held: number
  /** content we hold no key for */
  undecryptable: number
  /** envelopes cut by the permission rules or malformed */
  rejected: number
  /** devices with a proven equivocation */
  forkedDevices: number
}

export interface BoardView {
  id: string
  kind: BoardKind
  ws: string | null
  owner: string | null
  name: string
  desc: string
  columns: Column[]
  archivedColumns: Column[]
  cards: Map<string, Card>
  /** live cards per live column, in display order */
  byColumn: Map<string, Card[]>
  /** live cards whose column is archived or unknown */
  unsorted: Card[]
  archivedCards: Card[]
  movedOut: Card[]
  labels: Map<string, Label>
  /** field templates, archived ones included */
  fields: Map<string, FieldDef>
  /** workspaces: board categories, archived ones included */
  categories: Map<string, Category>
  /** workspaces: board id → category id as last placed (the category may since be archived) */
  placements: Map<string, string | null>
  members: Member[]
  profiles: Map<string, string>
  myRole: RoleOrNone
  aclHeads: string[]
  maxClockId: string | null
  /** every epoch key we hold, verified against its commitment */
  keys: KeyRing
  epochs: Map<string, EpochInfo>
  /** what new content should be encrypted under */
  writerEpoch: { id: string; key: Uint8Array } | null
  /** a valid epoch head reaches a non-member, or a member lacks a head */
  needsHeal: boolean
  /** workspaces only: the key the company network secret derives from */
  netEpoch: { id: string; key: Uint8Array } | null
  stats: BoardStats
  /** the content ops this fold applied, in fold order (what changed between two folds) */
  ops: AppliedOp[]
  resolved: Resolved
}

/** Plaintexts survive between folds; a failed decrypt is retried next time. */
export type DecryptCache = Map<string, BoardOp | null>

interface Applied {
  m: StoredMessage
  op: BoardOp
  lc: number
}

export interface AppliedOp {
  /** the envelope's id */
  id: string
  author: string
  ts: number
  op: BoardOp
}

function orderCmp(a: Applied, b: Applied): number {
  if (a.lc !== b.lc) return a.lc - b.lc
  if (a.m.author !== b.m.author) return a.m.author < b.m.author ? -1 : 1
  if (a.m.dev !== b.m.dev) return a.m.dev < b.m.dev ? -1 : 1
  return a.m.seq - b.m.seq
}

function posCmp<T extends { pos: string; id: string }>(a: T, b: T): number {
  if (a.pos !== b.pos) return a.pos < b.pos ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Every epoch key `me` can reach: own wraps, grants, then walk `prev` carries. */
function deriveKeys(
  board: string,
  res: Resolved,
  me: Identity,
): { keys: KeyRing; blobs: Map<string, { blob: EpochBlob; opId: string; valid: boolean }> } {
  const blobs = new Map<string, { blob: EpochBlob; opId: string; valid: boolean }>()
  const grants: KeyRing[] = []
  for (const m of res.aclOps) {
    const c = m.content as AclContent
    if (c.act === 'genesis' || c.act === 'remove' || c.act === 'rotate') {
      const existing = blobs.get(c.epoch.id)
      // an epoch id is the creator's random choice; keep the lowest-msgId claim
      if (!existing || m.id < existing.opId) {
        blobs.set(c.epoch.id, { blob: c.epoch, opId: m.id, valid: isAclValid(res, m.id) })
      }
    } else if (c.act === 'set-role' && c.grant && c.target === me.pub) {
      grants.push(openGrant(board, c.grant, me))
    }
  }

  const keys: KeyRing = new Map()
  const accept = (id: string, k: Uint8Array): boolean => {
    const b = blobs.get(id)
    if (!b || keys.has(id) || keyCommitment(board, id, k) !== b.blob.kc) return false
    keys.set(id, k)
    return true
  }
  for (const [id, { blob }] of blobs) {
    const k = openEpoch(board, blob, me)
    if (k) keys.set(id, k)
  }
  for (const g of grants) for (const [id, k] of g) accept(id, k)

  let grew = true
  const walked = new Set<string>()
  while (grew) {
    grew = false
    for (const [id, k] of [...keys]) {
      if (walked.has(id)) continue
      walked.add(id)
      const b = blobs.get(id)
      if (!b) continue
      for (const [pid, pk] of openCarried(board, b.blob, k)) if (accept(pid, pk)) grew = true
    }
  }
  return { keys, blobs }
}

/** Identifies the exact set of edits (create/update envelopes, comments) a card has had. */
export function editVersion(edits: string[]): string {
  return toB64url(sha256(utf8([...edits].sort().join('|'))).subarray(0, 16))
}

export function netSecret(ws: string, epochKey: Uint8Array): Uint8Array {
  return hkdf(sha256, epochKey, fromB64url(ws), utf8('lawha-net-v1'), 32)
}

/**
 * Fold a board's stored envelopes into what the UI shows. Pure given the
 * envelope set and identity (the cache only skips repeated decryption).
 */
export function computeBoard(
  board: string,
  messages: StoredMessage[],
  forks: ForkRecord[],
  me: Identity,
  cache: DecryptCache = new Map(),
): BoardView {
  const res = resolve(board, messages, forks)
  const { keys, blobs } = deriveKeys(board, res, me)

  let kind: BoardKind = 'board'
  let ws: string | null = null
  if (res.genesisId) {
    const g = res.aclOps[res.aclIndex.get(res.genesisId)!]!.content as AclContent
    if (g.act === 'genesis') {
      kind = g.kind
      ws = g.ws
    }
  }

  // ---- epochs: recipients, heads, writer key, heal need
  const epochs = new Map<string, EpochInfo>()
  for (const [id, b] of blobs) {
    epochs.set(id, { id, opId: b.opId, valid: b.valid, recipients: new Set(Object.keys(b.blob.wraps)) })
  }
  for (const m of res.aclOps) {
    const c = m.content as AclContent
    if (c.act === 'set-role' && c.grant && isAclValid(res, m.id)) {
      for (const id of Object.keys(c.grant.keys)) epochs.get(id)?.recipients.add(c.target)
    }
  }
  const carried = new Set<string>()
  for (const [, b] of blobs) if (b.valid) for (const pid of Object.keys(b.blob.prev)) carried.add(pid)
  const heads = [...epochs.values()].filter((e) => e.valid && !carried.has(e.id))
  const memberSet = new Set(res.roles.keys())
  const byOpDesc = (a: EpochInfo, b: EpochInfo) => (a.opId < b.opId ? 1 : -1)
  const clean = heads
    .filter((e) => keys.has(e.id) && [...e.recipients].every((p) => memberSet.has(p)))
    .sort(byOpDesc)
  const anyHeld = heads.filter((e) => keys.has(e.id)).sort(byOpDesc)
  const anyValid = [...epochs.values()].filter((e) => e.valid && keys.has(e.id)).sort(byOpDesc)
  const pick = clean[0] ?? anyHeld[0] ?? anyValid[0]
  const writerEpoch = pick ? { id: pick.id, key: keys.get(pick.id)! } : null
  const needsHeal =
    heads.some((e) => [...e.recipients].some((p) => !memberSet.has(p))) ||
    [...memberSet].some((p) => heads.some((e) => !e.recipients.has(p)))
  const netHead = [...heads].sort(byOpDesc)[0]
  const netEpoch = netHead && keys.has(netHead.id) ? { id: netHead.id, key: keys.get(netHead.id)! } : null

  // ---- decrypt + authorize content
  const applied: Applied[] = []
  let undecryptable = 0
  let rejected = 0
  for (const m of res.order) {
    if (m.type !== 'op') continue
    let op = cache.get(m.id)
    if (!op) {
      const c = m.content as OpContent
      const key = keys.get(c.epoch)
      if (!key) {
        undecryptable++
        continue
      }
      const plain = openOp(key, { board, author: m.author, dev: m.dev, seq: m.seq, epoch: c.epoch }, c.n, c.box)
      if (plain === undefined) {
        undecryptable++
        continue
      }
      if (opSchemaError(plain)) {
        cache.set(m.id, null)
        rejected++
        continue
      }
      op = plain as BoardOp
      cache.set(m.id, op)
    }
    if (op === null) {
      rejected++
      continue
    }
    if (!canWrite(res, m, requiredRank(op))) {
      rejected++
      continue
    }
    applied.push({ m, op, lc: res.lc.get(m.id)! })
  }
  for (const m of res.aclOps) if (!isAclValid(res, m.id)) rejected++
  applied.sort(orderCmp)

  // ---- last-writer-wins fold
  let name = ''
  let desc = ''
  const labels = new Map<string, Label>()
  const profiles = new Map<string, string>()
  const columns = new Map<string, Column>()
  const cards = new Map<string, Card & { created: boolean; movedVer: string; edits: string[] }>()
  const comments = new Map<string, Comment>()
  const fields = new Map<string, FieldDef>()
  const categories = new Map<string, Category>()
  const placements = new Map<string, string | null>()
  const entries = new Map<string, { id: string; card: string; field: string; value: FieldValue; removed: boolean }>()

  const cardStub = (id: string, a: Applied) => {
    let c = cards.get(id)
    if (!c) {
      c = {
        id,
        title: '',
        desc: '',
        labels: [],
        assignees: [],
        due: null,
        archived: false,
        col: '',
        pos: 'a0',
        movedTo: null,
        from: null,
        createdBy: a.m.author,
        createdAt: a.m.ts,
        updatedAt: a.m.ts,
        comments: [],
        fields: [],
        editedAfterMove: false,
        version: '',
        created: false,
        movedVer: '',
        edits: [],
      }
      cards.set(id, c)
    }
    c.updatedAt = Math.max(c.updatedAt, a.m.ts)
    return c
  }

  for (const a of applied) {
    const op = a.op
    switch (op.k) {
      case 'board.update':
        if (op.name !== undefined) name = op.name
        if (op.desc !== undefined) desc = op.desc
        break
      case 'label.set':
        labels.set(op.id, { id: op.id, name: op.name, color: op.color, archived: op.archived })
        break
      case 'profile.set':
        profiles.set(a.m.author, op.name)
        break
      case 'column.create':
        columns.set(op.id, { id: op.id, name: op.name, pos: op.pos, wip: null, archived: false })
        break
      case 'column.update': {
        const c = columns.get(op.id)
        if (!c) break
        if (op.name !== undefined) c.name = op.name
        if (op.pos !== undefined) c.pos = op.pos
        if (op.wip !== undefined) c.wip = op.wip
        if (op.archived !== undefined) c.archived = op.archived
        break
      }
      case 'card.create': {
        const c = cardStub(op.id, a)
        if (!c.created) {
          c.createdBy = a.m.author
          c.createdAt = a.m.ts
        }
        c.edits.push(a.m.id)
        Object.assign(c, {
          title: op.title,
          desc: op.desc,
          labels: op.labels,
          assignees: op.assignees,
          due: op.due,
          col: op.col,
          pos: op.pos,
          from: op.from,
          movedTo: null,
          created: true,
        })
        break
      }
      case 'card.update': {
        const c = cardStub(op.id, a)
        c.edits.push(a.m.id)
        if (op.title !== undefined) c.title = op.title
        if (op.desc !== undefined) c.desc = op.desc
        if (op.labels !== undefined) c.labels = op.labels
        if (op.assignees !== undefined) c.assignees = op.assignees
        if (op.due !== undefined) c.due = op.due
        if (op.archived !== undefined) c.archived = op.archived
        break
      }
      case 'card.move':
        for (const mv of op.moves) {
          const c = cardStub(mv.id, a)
          c.col = mv.col
          c.pos = mv.pos
          c.movedTo = null
        }
        break
      case 'card.moveOut':
        op.ids.forEach((id, i) => {
          const c = cardStub(id, a)
          c.movedTo = op.to
          c.movedVer = op.vers[i]!
        })
        break
      case 'comment.add':
        if (!comments.has(op.id)) {
          comments.set(op.id, {
            id: op.id,
            card: op.card,
            author: a.m.author,
            text: op.text,
            ts: a.m.ts,
            imported: op.imported,
          })
        }
        break
      case 'field.set': {
        // the type stays what it was first written as, so existing values keep their meaning
        const type = fields.get(op.id)?.type ?? op.type
        fields.set(op.id, { id: op.id, name: op.name, type, options: op.options, archived: op.archived })
        break
      }
      case 'entry.set': {
        // an entry belongs to one card and one field for good; Map order is first-write order
        const e = entries.get(op.id)
        if (e && (e.card !== op.card || e.field !== op.field)) break
        entries.set(op.id, { id: op.id, card: op.card, field: op.field, value: op.value, removed: op.removed })
        cardStub(op.card, a).edits.push(a.m.id)
        break
      }
      case 'category.set':
        categories.set(op.id, { id: op.id, name: op.name, pos: op.pos, archived: op.archived })
        break
      case 'board.place':
        placements.set(op.board, op.category)
        break
    }
  }

  for (const e of entries.values()) {
    const def = fields.get(e.field)
    const c = cards.get(e.card)
    if (e.removed || !def || def.archived || !c) continue
    c.fields.push({ id: e.id, field: e.field, value: fieldValueOk(def, e.value) ? e.value : null })
  }

  for (const cm of comments.values()) {
    const c = cards.get(cm.card)
    if (!c) continue
    c.comments.push(cm)
    c.edits.push(cm.id)
  }

  const liveColumns = [...columns.values()].filter((c) => !c.archived).sort(posCmp)
  const archivedColumns = [...columns.values()].filter((c) => c.archived).sort(posCmp)
  const liveColIds = new Set(liveColumns.map((c) => c.id))
  const byColumn = new Map<string, Card[]>(liveColumns.map((c) => [c.id, []]))
  const unsorted: Card[] = []
  const archivedCards: Card[] = []
  const movedOut: Card[] = []
  const outCards = new Map<string, Card>()
  for (const c of cards.values()) {
    if (!c.created) continue
    const { created: _c, movedVer, edits, ...card } = c
    card.version = editVersion(edits)
    card.editedAfterMove = card.movedTo !== null && card.version !== movedVer
    card.comments.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
    outCards.set(card.id, card)
    if (card.movedTo !== null) movedOut.push(card)
    else if (card.archived) archivedCards.push(card)
    else if (liveColIds.has(card.col)) byColumn.get(card.col)!.push(card)
    else unsorted.push(card)
  }
  for (const list of byColumn.values()) list.sort(posCmp)
  unsorted.sort(posCmp)

  const members: Member[] = [...res.roles.entries()]
    .map(([pub, role]) => ({
      pub,
      role,
      name: profiles.get(pub) ?? '',
      devices: (res.devices.get(pub) ?? []).map(({ dev, seq, lastTs, count }) => ({ dev, seq, lastTs, count })),
    }))
    .sort((a, b) => RANK[b.role] - RANK[a.role] || a.name.localeCompare(b.name) || (a.pub < b.pub ? -1 : 1))

  return {
    id: board,
    kind,
    ws,
    owner: res.owner,
    name,
    desc,
    columns: liveColumns,
    archivedColumns,
    cards: outCards,
    byColumn,
    unsorted,
    archivedCards,
    movedOut,
    labels,
    fields,
    categories,
    placements,
    members,
    profiles,
    myRole: res.roles.get(me.pub) ?? 'none',
    aclHeads: res.aclHeads,
    maxClockId: res.maxClockId,
    keys,
    epochs,
    writerEpoch,
    needsHeal,
    netEpoch,
    stats: {
      held: res.held.size,
      undecryptable,
      rejected,
      forkedDevices: new Set(forks.map((f) => `${f.author}.${f.dev}`)).size,
    },
    ops: applied.map((a) => ({ id: a.m.id, author: a.m.author, ts: a.m.ts, op: a.op })),
    resolved: res,
  }
}

// ---- positions ----

/**
 * `n` keys to insert at `index` of a column whose current keys are `sorted`.
 * Equal neighbours (two concurrent inserts landed on one key) are skipped so
 * generateKeyBetween is never asked for a key between a key and itself.
 */
export function positionsAt(sorted: string[], index: number, n: number): string[] {
  const a = index > 0 ? sorted[index - 1]! : null
  let j = index
  while (a !== null && j < sorted.length && sorted[j]! <= a) j++
  const b = j < sorted.length ? sorted[j]! : null
  return generateNKeysBetween(a, b, n)
}

/** Fresh evenly spaced keys when a column's keys have grown too long. */
export function needsRenormalize(sorted: string[]): boolean {
  return sorted.some((p) => p.length > RENORMALIZE_POS)
}

export function freshPositions(n: number): string[] {
  return generateNKeysBetween(null, null, n)
}
