import { create } from 'zustand'

// sw.js skips waiting: when a deploy is found it precaches the new build,
// deletes the old cache and claims every open tab. A tab opened before that
// keeps running the old build, whose lazy chunks are now gone from both the
// cache and the server, so it is offered a reload.
//
// Browsers only look for a new sw.js on navigation, which a tab left open for
// days never does. Ask hourly while the tab is visible, and again when it
// comes back to the foreground or online, but at most once per 10 min: GitHub
// Pages serves with max-age=600, so asking sooner cannot see anything newer.
const CHECK_EVERY_MS = 60 * 60 * 1000
const MIN_GAP_MS = 10 * 60 * 1000

export const useSwUpdate = create<{ ready: boolean }>(() => ({ ready: false }))

/**
 * True once the active worker's cache no longer holds the script and styles
 * this page was loaded with (their URLs carry content hashes), i.e. a newer
 * build has replaced ours. A failed lookup counts as up to date.
 */
async function isStale(): Promise<boolean> {
  const urls = [
    ...[...document.querySelectorAll<HTMLScriptElement>('script[src]')].map((s) => s.src),
    ...[...document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]')].map((l) => l.href),
  ]
  try {
    const hits = await Promise.all(urls.map((u) => caches.match(u, { ignoreVary: true })))
    return hits.some((h) => !h)
  } catch {
    return false
  }
}

export function registerServiceWorker(): void {
  const sw = navigator.serviceWorker
  // The first install claims the tab too; isStale() tells it from an update.
  // A tab already controlled switches to the new worker before its activate
  // handler has deleted the old cache, so look once it is 'activated'.
  sw.addEventListener('controllerchange', () => {
    const worker = sw.controller
    if (!worker) return
    const settle = () => {
      if (worker.state !== 'activated') return
      worker.removeEventListener('statechange', settle)
      void isStale().then((stale) => {
        if (stale) useSwUpdate.setState({ ready: true })
      })
    }
    worker.addEventListener('statechange', settle)
    settle()
  })
  window.addEventListener('load', () => {
    sw.register(`${import.meta.env.BASE_URL}sw.js`)
      .then((reg) => {
        let last = Date.now() // the navigation that loaded us just checked
        const check = () => {
          if (document.visibilityState !== 'visible' || !navigator.onLine) return
          if (Date.now() - last < MIN_GAP_MS) return
          last = Date.now()
          reg.update().catch(() => {})
        }
        setInterval(check, CHECK_EVERY_MS)
        document.addEventListener('visibilitychange', check)
        window.addEventListener('online', check)
      })
      .catch(() => {})
  })
}

/** The new worker already controls this tab, so a reload loads the new build. */
export function applyUpdate(): void {
  location.reload()
}

/** Hidden until the next deploy is found. */
export function dismissUpdate(): void {
  useSwUpdate.setState({ ready: false })
}
