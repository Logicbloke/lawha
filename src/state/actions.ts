import { B64_32 } from '../core/b64'
import { isB64 } from '../core/validate'
import {
  ActionError,
  createBoardItems,
  leaveItem,
  moveCardsItems,
  moveCardsToBoardItems,
  moveColumnItem,
  newEntityId,
  opItem,
  removeItem,
  rotateItem,
  setRoleItem,
} from '../core/actions'
import { MAX_OP_JSON, opJsonSize } from '../core/boardcrypto'
import { positionsAt, type BoardOp, type BoardView, type LabelColor } from '../core/board'
import { deleteContact, getContacts, putContact } from '../core/db'
import type { ContactRecord, Role } from '../core/types'
import { getDb, getEngine, me, navigate, setWorkspace, toast, useApp } from './store'
import { translate, type TKey } from '../ui/i18n'

/** User-facing actions. Errors become toasts in the user's language. */

function t(key: TKey, vars?: Record<string, string | number>): string {
  return translate(useApp.getState().lang, key, vars)
}

async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const key: TKey =
      msg === 'not allowed'
        ? 'errNotAllowed'
        : msg === 'no board key'
          ? 'errNoKey'
          : msg === 'board not synced'
            ? 'errNotSynced'
            : msg === 'op too large'
              ? 'errTooLarge'
              : 'errGeneric'
    toast(t(key), 'error')
    if (!(e instanceof ActionError)) console.warn(e)
    return undefined
  }
}

function view(board: string): BoardView {
  const v = getEngine().view(board)
  if (!v) throw new ActionError('board not synced')
  return v
}

async function op(board: string, o: BoardOp): Promise<void> {
  if (opJsonSize(o) > MAX_OP_JSON) throw new Error('op too large')
  await getEngine().write([opItem(view(board), o)])
}

// ---- boards & workspaces ----

export function createBoard(name: string, ws: string | null): Promise<string | undefined> {
  return run(async () => {
    const items = createBoardItems(me(), {
      kind: 'board',
      ws,
      name,
      myName: '',
      columns: [t('colTodo'), t('colDoing'), t('colDone')],
    })
    const id = await getEngine().create('board', ws, items)
    navigate({ name: 'board', id })
    return id
  })
}

export function createWorkspace(name: string): Promise<string | undefined> {
  return run(async () => {
    const items = createBoardItems(me(), { kind: 'workspace', ws: null, name, myName: '', columns: [] })
    const id = await getEngine().create('workspace', null, items)
    setWorkspace(id)
    navigate({ name: 'members', id })
    return id
  })
}

export const renameBoard = (board: string, name: string) => run(() => op(board, { k: 'board.update', name }))
export const setBoardDesc = (board: string, desc: string) => run(() => op(board, { k: 'board.update', desc }))
export const setMyName = (board: string, name: string) => run(() => op(board, { k: 'profile.set', name }))

export function hideBoard(board: string, hidden: boolean): Promise<void | undefined> {
  return run(() => getEngine().setHidden(board, hidden))
}

// ---- columns ----

export function addColumn(board: string, name: string): Promise<void | undefined> {
  return run(async () => {
    const v = view(board)
    const pos = positionsAt(v.columns.map((c) => c.pos), v.columns.length, 1)[0]!
    await op(board, { k: 'column.create', id: newEntityId(), name, pos })
  })
}

export const renameColumn = (board: string, id: string, name: string) =>
  run(() => op(board, { k: 'column.update', id, name }))
export const setColumnWip = (board: string, id: string, wip: number | null) =>
  run(() => op(board, { k: 'column.update', id, wip }))
export const archiveColumn = (board: string, id: string, archived: boolean) =>
  run(() => op(board, { k: 'column.update', id, archived }))

export function moveColumn(board: string, id: string, index: number): Promise<void | undefined> {
  return run(async () => {
    await getEngine().write([moveColumnItem(view(board), id, index)])
  })
}

// ---- cards ----

export function addCard(board: string, col: string, title: string): Promise<string | undefined> {
  return run(async () => {
    const v = view(board)
    const cards = v.byColumn.get(col) ?? []
    const pos = positionsAt(cards.map((c) => c.pos), cards.length, 1)[0]!
    const id = newEntityId()
    await op(board, { k: 'card.create', id, col, pos, title, desc: '', labels: [], assignees: [], due: null, from: null })
    return id
  })
}

export type CardPatch = Partial<{
  title: string
  desc: string
  labels: string[]
  assignees: string[]
  due: string | null
  archived: boolean
}>

export const updateCard = (board: string, id: string, patch: CardPatch) =>
  run(() => op(board, { k: 'card.update', id, ...patch }))

export function moveCards(board: string, ids: string[], col: string, index: number): Promise<void | undefined> {
  return run(async () => {
    await getEngine().write(moveCardsItems(view(board), ids, col, index))
  })
}

export function archiveCards(board: string, ids: string[]): Promise<void | undefined> {
  return run(async () => {
    const v = view(board)
    await getEngine().write(ids.map((id) => opItem(v, { k: 'card.update', id, archived: true })))
  })
}

export function moveCardsToBoard(
  src: string,
  dst: string,
  ids: string[],
  col: string,
): Promise<void | undefined> {
  return run(async () => {
    const d = view(dst)
    const { items } = moveCardsToBoardItems(view(src), d, ids, col, (d.byColumn.get(col) ?? []).length)
    await getEngine().write(items)
    toast(t('movedN', { n: ids.length, board: d.name }))
  })
}

export const addComment = (board: string, card: string, text: string) =>
  run(() => op(board, { k: 'comment.add', id: newEntityId(), card, text, imported: null }))

export function setLabel(
  board: string,
  label: { id?: string; name: string; color: LabelColor; archived?: boolean },
): Promise<string | undefined> {
  return run(async () => {
    const id = label.id ?? newEntityId()
    await op(board, { k: 'label.set', id, name: label.name, color: label.color, archived: label.archived ?? false })
    return id
  })
}

// ---- members ----

export function isPubKey(s: string): boolean {
  return isB64(s.trim(), B64_32)
}

export function addMember(board: string, pub: string, role: Exclude<Role, 'owner'>): Promise<void | undefined> {
  return run(async () => {
    await getEngine().write([setRoleItem(view(board), me(), pub.trim(), role)])
  })
}

export const setMemberRole = addMember

export function removeMember(board: string, pub: string): Promise<void | undefined> {
  return run(async () => {
    await getEngine().write([removeItem(view(board), me(), pub)])
  })
}

/** Remove someone from a workspace and from every company board where we can. */
export function removeFromCompany(ws: string, pub: string): Promise<void | undefined> {
  return run(async () => {
    const engine = getEngine()
    await engine.write([removeItem(view(ws), me(), pub)])
    for (const r of engine.records()) {
      if (engine.wsOf(r.id) !== ws || r.id === ws) continue
      const v = engine.view(r.id)
      if (!v || !v.members.some((m) => m.pub === pub)) continue
      try {
        await engine.write([removeItem(v, me(), pub)])
      } catch {
        // not an admin there, or they outrank us
      }
    }
  })
}

export function leaveBoard(board: string): Promise<void | undefined> {
  return run(async () => {
    await getEngine().write([leaveItem(view(board), me())])
    await getEngine().setHidden(board, true)
    navigate({ name: 'home' })
  })
}

export function rotateKey(board: string): Promise<void | undefined> {
  return run(async () => {
    await getEngine().write([rotateItem(view(board))])
  })
}

// ---- invites ----

export interface Invite {
  board: string
  ws: string | null
}

/** `lawha:b:<board>[:<ws>]` — compact enough for a QR code. */
export function inviteCode(board: string, ws: string | null): string {
  return ws && ws !== board ? `lawha:b:${board}:${ws}` : board === ws ? `lawha:w:${board}` : `lawha:b:${board}`
}

export function inviteLink(base: string, board: string, ws: string | null): string {
  return `${base}#/join/${inviteCode(board, ws).slice('lawha:'.length).replace(/:/g, '/')}`
}

/** Accepts a full invite link, a `#/join/...` fragment or a `lawha:` code. */
export function parseInvite(input: string): Invite | null {
  let s = input.trim()
  const hash = s.indexOf('#/join/')
  if (hash >= 0) s = 'lawha:' + s.slice(hash + '#/join/'.length).replace(/\//g, ':')
  if (!s.startsWith('lawha:')) s = 'lawha:' + s.replace(/\//g, ':')
  const [, kind, a, b] = s.split(':')
  if (!a || !isB64(a, B64_32)) return null
  if (kind === 'w') return { board: a, ws: a }
  if (kind === 'b') return { board: a, ws: b && isB64(b, B64_32) ? b : null }
  return null
}

export function joinInvite(inv: Invite): Promise<void | undefined> {
  return run(async () => {
    const engine = getEngine()
    if (inv.ws && inv.ws !== inv.board) await engine.follow(inv.ws, inv.ws)
    await engine.follow(inv.board, inv.ws)
    if (inv.ws === inv.board) {
      setWorkspace(inv.board)
      navigate({ name: 'members', id: inv.board })
    } else {
      setWorkspace(inv.ws)
      navigate({ name: 'board', id: inv.board })
    }
  })
}

// ---- contacts ----

export function listContacts(): Promise<ContactRecord[]> {
  return getContacts(getDb())
}

export function saveContact(pub: string, name: string): Promise<void | undefined> {
  return run(async () => {
    await putContact(getDb(), { pub: pub.trim(), name: name.trim(), addedAt: Date.now() })
  })
}

export function forgetContact(pub: string): Promise<void | undefined> {
  return run(() => deleteContact(getDb(), pub))
}
