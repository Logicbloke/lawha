import { create } from 'zustand'
import { RANK } from '../core/types'
import { getEngine, useApp } from './store'

/**
 * Board categories in the sidebar. A company's live in its workspace log, so
 * every coworker sees the same grouping and only workspace admins change it.
 * Personal boards (no company) are grouped per device, sealed under the
 * install's local key in localStorage. Collapsing is always per device.
 */

export interface CategoryItem {
  id: string
  name: string
  pos: string
}

export interface Grouping {
  /** live categories in display order */
  categories: CategoryItem[]
  /** the live category a board is in, or null for the main list */
  placeOf(board: string): string | null
  canManage: boolean
}

export interface LocalCategories {
  categories: CategoryItem[]
  place: Record<string, string>
}

const LOCAL_KEY = 'lawha-categories'
const COLLAPSED_KEY = 'lawha-collapsed'

function readCollapsed(): string[] {
  try {
    const x: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

/** `v` bumps on every change to the personal categories, so readers re-render */
const useLocal = create(() => ({ v: 0, collapsed: readCollapsed() }))

let local: LocalCategories | null = null

function isLocalCategories(x: unknown): x is LocalCategories {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return (
    Array.isArray(o.categories) &&
    o.categories.every(
      (c: unknown) =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as CategoryItem).id === 'string' &&
        typeof (c as CategoryItem).name === 'string' &&
        typeof (c as CategoryItem).pos === 'string',
    ) &&
    typeof o.place === 'object' &&
    o.place !== null &&
    Object.values(o.place).every((v) => typeof v === 'string')
  )
}

export function localCategories(): LocalCategories {
  if (!local) {
    local = { categories: [], place: {} }
    try {
      const raw = localStorage.getItem(LOCAL_KEY)
      const text = raw ? getEngine().openText(raw) : null
      const parsed: unknown = text ? JSON.parse(text) : null
      if (isLocalCategories(parsed)) local = parsed
    } catch {
      // unreadable (private mode, another key): start empty
    }
  }
  return local
}

export function saveLocalCategories(next: LocalCategories): void {
  local = next
  try {
    localStorage.setItem(LOCAL_KEY, getEngine().sealText(JSON.stringify(next)))
  } catch {
    // kept for this session only
  }
  useLocal.setState((s) => ({ v: s.v + 1 }))
}

const byPos = (a: CategoryItem, b: CategoryItem) => (a.pos !== b.pos ? (a.pos < b.pos ? -1 : 1) : a.id < b.id ? -1 : 1)

/** The grouping of the sidebar for a workspace, or for personal boards (`ws` null). */
export function grouping(ws: string | null): Grouping {
  if (ws) {
    const v = getEngine().view(ws)
    const categories = v
      ? [...v.categories.values()].filter((c) => !c.archived).map(({ id, name, pos }) => ({ id, name, pos })).sort(byPos)
      : []
    const live = new Set(categories.map((c) => c.id))
    return {
      categories,
      placeOf: (board) => {
        const c = v?.placements.get(board) ?? null
        return c !== null && live.has(c) ? c : null
      },
      canManage: !!v && RANK[v.myRole] >= RANK.admin,
    }
  }
  const l = localCategories()
  const categories = [...l.categories].sort(byPos)
  const live = new Set(categories.map((c) => c.id))
  return {
    categories,
    placeOf: (board) => {
      const c = l.place[board]
      return c !== undefined && live.has(c) ? c : null
    },
    canManage: true,
  }
}

export function useGrouping(ws: string | null): Grouping {
  useApp((s) => s.version)
  useLocal((s) => s.v)
  return grouping(ws)
}

/** Boards split into the main list and each category, keeping the given order. */
export function groupBoards(
  ids: string[],
  g: Grouping,
): { loose: string[]; groups: Array<{ category: CategoryItem; ids: string[] }> } {
  const groups = g.categories.map((category) => ({ category, ids: [] as string[] }))
  const index = new Map(groups.map((x, i) => [x.category.id, i]))
  const loose: string[] = []
  for (const id of ids) {
    const at = index.get(g.placeOf(id) ?? '')
    if (at === undefined) loose.push(id)
    else groups[at]!.ids.push(id)
  }
  return { loose, groups }
}

export function useCollapsed(): string[] {
  return useLocal((s) => s.collapsed)
}

export function toggleCollapsed(id: string): void {
  const cur = useLocal.getState().collapsed
  const collapsed = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
  } catch {
    // not persisted
  }
  useLocal.setState({ collapsed })
}
