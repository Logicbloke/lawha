import { useEffect, useState } from 'react'
import { useT } from './i18n'
import { isNewer } from './version'

const REPO = 'Logicbloke/lawha'
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`
const SINGLE_FILE_ASSET = `${RELEASES_PAGE}/download/lawha.html`
const CHECK_KEY = 'lawha:updateCheck'
const DISMISS_KEY = 'lawha:updateDismissed'
const CHECK_TTL_MS = 6 * 60 * 60 * 1000 // re-check at most every 6h
const FETCH_TIMEOUT_MS = 5000

// The canonical hosted PWA auto-updates via its service worker on the next
// online load (UpdateToast offers the reload to tabs left open), so a banner
// there would be misleading. Everywhere else —
// file://, self-hosted static, localhost — nothing pulls new code, so the
// check is worth running.
const IS_CANONICAL_HOST =
  typeof location !== 'undefined' && location.hostname === 'logicbloke.github.io'

type Cached = { checkedAt: number; latest: string }

function readCache(): Cached | null {
  try {
    const raw = localStorage.getItem(CHECK_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Cached
    return typeof c.checkedAt === 'number' && typeof c.latest === 'string' ? c : null
  } catch {
    return null
  }
}

/** Best-effort fetch of the latest release tag. Any failure ⇒ null. */
async function fetchLatestTag(): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(RELEASES_API, {
      signal: ctrl.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { tag_name?: string }
    return typeof body.tag_name === 'string' ? body.tag_name : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Resolve the newest known release tag, using the throttled cache. */
async function resolveLatest(): Promise<string | null> {
  const cached = readCache()
  if (cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) return cached.latest
  const tag = await fetchLatestTag()
  if (tag) {
    try {
      localStorage.setItem(CHECK_KEY, JSON.stringify({ checkedAt: Date.now(), latest: tag }))
    } catch {
      /* storage full / disabled — the check is best-effort */
    }
    return tag
  }
  return cached?.latest ?? null
}

/**
 * Shows a dismissable banner when a newer GitHub release exists. Silent and
 * non-blocking: offline, rate-limited, or blocked checks simply show nothing.
 */
export function UpdateBanner() {
  const t = useT()
  const [latest, setLatest] = useState<string | null>(null)

  useEffect(() => {
    if (!import.meta.env.PROD || IS_CANONICAL_HOST) return
    let live = true
    void resolveLatest().then((tag) => {
      if (!live || !tag) return
      if (!isNewer(tag, __APP_VERSION__)) return
      let dismissed: string | null = null
      try {
        dismissed = localStorage.getItem(DISMISS_KEY)
      } catch {
        /* ignore */
      }
      if (dismissed === tag) return
      setLatest(tag)
    })
    return () => {
      live = false
    }
  }, [])

  if (!latest) return null

  const href = location.protocol === 'file:' ? SINGLE_FILE_ASSET : RELEASES_PAGE

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, latest)
    } catch {
      /* ignore */
    }
    setLatest(null)
  }

  return (
    <div className="update-banner" role="status">
      <span>{t('updateAvailable', { v: latest })}</span>
      <span className="update-actions">
        <a href={href} target="_blank" rel="noopener noreferrer">
          {t('updateDownload')}
        </a>
        <button className="link" onClick={dismiss}>
          {t('updateDismiss')}
        </button>
      </span>
    </div>
  )
}
