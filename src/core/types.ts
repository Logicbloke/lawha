/**
 * Wire and storage types. Everything that is signed must stay within what
 * canonical.ts accepts: strings, safe integers, null, and objects/arrays of
 * those. No booleans, no floats.
 */

export type Role = 'owner' | 'admin' | 'editor' | 'viewer'
/** a role event's outcome: a role, or out of the board */
export type RoleOrNone = Role | 'none'

export const RANK: Record<RoleOrNone, number> = {
  none: -1,
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
}

export type EnvelopeType = 'acl' | 'op'

/**
 * One device's cutoff on a member's chains: [seq, msgId] of the last envelope
 * the actor had seen from that device. Envelopes past it are cut once the
 * role event that carries it wins.
 */
export type UpTo = Record<string, [number, string]>

/**
 * A board key epoch. `wraps` seals the key to each recipient (ephemeral X25519
 * per epoch); `prev` carries every epoch-head key the creator held, sealed
 * under this key, so the newest key unlocks all history. `kc` commits to the
 * key so a malicious admin cannot hand different members different keys.
 */
export interface EpochBlob {
  id: string
  kc: string
  epk: string
  wraps: Record<string, string>
  prev: Record<string, string>
}

/** Existing epoch keys sealed to one newly granted member. */
export interface GrantBlob {
  epk: string
  keys: Record<string, string>
}

export type BoardKind = 'board' | 'workspace'

/**
 * Creates a board or a workspace. A workspace is a board-like log whose
 * members are a company's roster; its epoch key derives the company network
 * secret. A board names the workspace it belongs to (null = personal).
 */
export interface GenesisAcl {
  act: 'genesis'
  acl: string[]
  nonce: string
  kind: BoardKind
  ws: string | null
  epoch: EpochBlob
}

export interface SetRoleAcl {
  act: 'set-role'
  acl: string[]
  target: string
  role: 'admin' | 'editor' | 'viewer'
  /** present on downgrades: cutoff for the target's higher-privileged writes */
  upTo: UpTo
  /** present when the target may not hold the current keys yet */
  grant: GrantBlob | null
}

export interface RemoveAcl {
  act: 'remove'
  acl: string[]
  target: string
  upTo: UpTo
  epoch: EpochBlob
}

export interface LeaveAcl {
  act: 'leave'
  acl: string[]
  upTo: UpTo
}

export interface RotateAcl {
  act: 'rotate'
  acl: string[]
  epoch: EpochBlob
}

export type AclContent = GenesisAcl | SetRoleAcl | RemoveAcl | LeaveAcl | RotateAcl

/** An encrypted board operation; the op kind is inside `box`. */
export interface OpContent {
  /** ACL heads the author had seen when writing */
  acl: string[]
  epoch: string
  n: string
  box: string
}

/**
 * The wire format. One signed hash chain per (board, author, dev): `prev` is
 * the msgId of the previous envelope on that chain (null iff seq === 1), seq
 * is dense and 1-based. `dep` names the highest-clock envelope the writer had
 * seen; the Lamport clock is derived from it, never declared.
 */
export interface Envelope {
  v: 1
  board: string
  author: string
  dev: string
  seq: number
  prev: string | null
  ts: number
  dep: string | null
  type: EnvelopeType
  content: AclContent | OpContent
  sig: string
}

export interface StoredMessage extends Envelope {
  /** b64url(sha256(canonical(envelope incl. sig))) */
  id: string
  receivedAt: number
}

export interface Head {
  board: string
  author: string
  dev: string
  seq: number
  id: string
}

/** Proof that one device signed two different envelopes at one seq. */
export interface ForkRecord {
  board: string
  author: string
  dev: string
  seq: number
  a: Envelope
  b: Envelope
}

export interface ScryptParams {
  N: number
  r: number
  p: number
}

export interface IdentityRecord {
  id: 'self'
  pub: string
  /** present when stored without a passphrase */
  seed?: string
  /** present when encrypted at rest */
  enc?: {
    salt: string
    nonce: string
    box: string
    scrypt: ScryptParams
  }
}

/** See core/session.ts — the seed under a non-extractable WebCrypto key. */
export interface SessionRecord {
  id: 'self'
  pub: string
  key: CryptoKey
  iv: Uint8Array
  box: Uint8Array
  createdAt: number
  expiresAt: number
}

export interface DeviceRecord {
  id: 'self'
  dev: string
}

/** A board this device follows. The name cache is sealed with the local key. */
export interface BoardRecord {
  id: string
  kind: BoardKind
  /** workspace the board belongs to (from its genesis or invite); null = personal */
  ws: string | null
  joinedAt: number
  /** last local write, drives which rooms stay joined */
  lastWriteAt: number
  /** b64url nonce + box of the board name under the local cache key */
  nameCache: { n: string; box: string } | null
  hidden: number
}

/** The sealed pieces of one attachment this device holds (see core/blobs.ts). */
export interface BlobRecord {
  root: string
  /** pieces in the file */
  n: number
  /** bit i set: piece i is stored */
  got: Uint8Array
  count: number
  /** sealed bytes stored */
  bytes: number
  /** our own upload: never evicted for space */
  pinned: number
  usedAt: number
}

export interface ContactRecord {
  pub: string
  name: string
  addedAt: number
}

export interface Identity {
  pub: string
  pubBytes: Uint8Array
  seed: Uint8Array
}
