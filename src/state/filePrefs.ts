import { create } from 'zustand'
import { DEFAULT_EAGER_BYTES } from '../core/engine'

/**
 * How big a file of each board this device fetches by itself, as soon as it
 * is added (see Engine.eagerLimit). Kept on this device only, like the
 * notification choices; 0 is "only when opened".
 */

const MB = 1024 * 1024
export const EAGER_CHOICES = [0, 2 * MB, 10 * MB, 25 * MB] as const

const prefKey = (board: string) => `lawha:files:${board}`

export const useFilePrefs = create<Record<string, number>>(() => ({}))

export function eagerLimitFor(board: string): number {
  const set = useFilePrefs.getState()[board]
  if (set !== undefined) return set
  try {
    const raw = localStorage.getItem(prefKey(board))
    const n = raw === null ? NaN : Number(raw)
    return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_EAGER_BYTES
  } catch {
    return DEFAULT_EAGER_BYTES
  }
}

export function useEagerLimit(board: string): number {
  return useFilePrefs((s) => s[board]) ?? eagerLimitFor(board)
}

export function saveEagerLimit(board: string, bytes: number): void {
  try {
    localStorage.setItem(prefKey(board), String(bytes))
  } catch {
    // not persisted: it still holds for this session
  }
  useFilePrefs.setState({ [board]: bytes })
}
