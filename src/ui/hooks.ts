import { useEffect, useState } from 'react'
import { getEngine, useApp } from '../state/store'
import type { BoardView } from '../core/board'

/** The folded board, re-read whenever any board changes. */
export function useBoard(id: string | null): BoardView | null {
  useApp((s) => s.version)
  if (!id) return null
  try {
    return getEngine().view(id)
  } catch {
    return null
  }
}

/** Board ids the sidebar lists for a workspace (null = personal). */
export function useBoardIds(ws: string | null): string[] {
  useApp((s) => s.version)
  const engine = getEngine()
  return engine
    .records()
    .filter((r) => !r.hidden && r.kind === 'board' && engine.wsOf(r.id) === ws)
    .sort((a, b) => engine.boardName(a.id).localeCompare(engine.boardName(b.id)) || a.joinedAt - b.joinedAt)
    .map((r) => r.id)
}

export function shortKey(pub: string): string {
  return pub.slice(0, 8)
}

/** A single shared 30 s clock for relative timestamps. */
const tickListeners = new Set<() => void>()
let tickTimer: ReturnType<typeof setInterval> | undefined

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const cb = () => setNow(Date.now())
    tickListeners.add(cb)
    if (!tickTimer) tickTimer = setInterval(() => tickListeners.forEach((l) => l()), 30_000)
    return () => {
      tickListeners.delete(cb)
      if (tickListeners.size === 0 && tickTimer) {
        clearInterval(tickTimer)
        tickTimer = undefined
      }
    }
  }, [])
  return now
}

const REL_UNITS: [ms: number, unit: Intl.RelativeTimeFormatUnit][] = [
  [1000, 'second'],
  [60_000, 'minute'],
  [3600_000, 'hour'],
  [86_400_000, 'day'],
  [7 * 86_400_000, 'week'],
  [30 * 86_400_000, 'month'],
  [365 * 86_400_000, 'year'],
]

export function formatRelative(ts: number, now: number, locale: string): string {
  const diff = Math.min(ts - now, -1000)
  let ms = 1000
  let unit: Intl.RelativeTimeFormatUnit = 'second'
  for (const [next, u] of REL_UNITS) {
    if (Math.abs(diff) < next) break
    ms = next
    unit = u
  }
  return new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' }).format(Math.round(diff / ms), unit)
}

export function formatDue(due: string, locale: string): string {
  const [y, m, d] = due.split('-').map(Number)
  return new Date(y!, m! - 1, d!).toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

export function formatDate(date: string, locale: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y!, m! - 1, d!).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function isOverdue(due: string, now: number): boolean {
  const [y, m, d] = due.split('-').map(Number)
  return new Date(y!, m! - 1, d! + 1).getTime() < now
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** A file size in the user's language: 820 kB, 4.2 MB. */
export function formatBytes(bytes: number, locale: string): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const
  let n = bytes
  let i = 0
  while (n >= 1000 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: units[i],
    unitDisplay: 'short',
    maximumFractionDigits: n < 10 && i > 0 ? 1 : 0,
  }).format(n)
}
