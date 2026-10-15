import { execSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
const SINGLE_FILE = env?.SINGLE_FILE === '1'

// Version baked into the client so a build can tell whether it is behind the
// latest GitHub release (see src/ui/UpdateBanner.tsx). Prefer an explicit
// APP_VERSION (CI passes the release tag) so official builds match the tag
// exactly; fall back to `git describe` for local builds, then package.json.
function resolveVersion(): string {
  if (env?.APP_VERSION) return env.APP_VERSION
  try {
    return execSync('git describe --tags --always --dirty', { encoding: 'utf8' }).trim()
  } catch {
    try {
      const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')) as {
        version?: string
      }
      return pkg.version ? `v${pkg.version}` : 'unknown'
    } catch {
      return 'unknown'
    }
  }
}
const APP_VERSION = resolveVersion()

// Strict CSP is injected only into production builds: the dev server needs
// inline scripts for React refresh, and localhost is not the threat surface.
// The single-file build inlines all code into index.html, so it must allow
// inline script/style — the file itself is the trust boundary there.
const CSP = [
  "default-src 'self'",
  SINGLE_FILE ? "script-src 'unsafe-inline'" : "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  // api.github.com: best-effort release-version check (UpdateBanner). Fails
  // silently if blocked; the app never depends on it.
  "connect-src 'self' ws: wss: https://api.github.com",
  // blob:: attachments decrypted in the page (a picture or video only, never
  // a document: see core/sniff.ts); data:: their small previews
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  // no frame-ancestors: it is ignored in <meta> CSP and just logs a warning
].join('; ')

function injectCsp(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<!--csp-->',
        `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
      )
    },
  }
}

// Files that live in public/ and must also work offline once installed.
// Kept in sync by hand — the bundle hook below only sees Rollup-emitted files.
const PUBLIC_PRECACHE = [
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
]

/**
 * Emits sw.js for the hosted build so the app is installable as a PWA and
 * works offline. Hashed assets are cache-first; navigations are
 * network-first (a deploy is picked up on the next online load) falling back
 * to the cached shell. The cache name is derived from the asset file names,
 * which contain content hashes — any changed bundle produces a new cache and
 * evicts the old one on activate.
 */
function serviceWorker(): Plugin {
  return {
    name: 'service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter((f) => f !== 'index.html')
      let h = 5381
      for (const c of assets.join('|')) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0
      const precache = ['./', './index.html', ...[...PUBLIC_PRECACHE, ...assets].map((f) => `./${f}`)]
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: `const CACHE = 'lawha-${h.toString(36)}'
const ASSETS = ${JSON.stringify(precache)}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => k === CACHE || caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('./', copy))
          return res
        })
        .catch(() => caches.match('./', { ignoreVary: true })),
    )
    return
  }
  // ignoreVary: precached responses may carry Vary headers that would
  // otherwise fail to match the page's crossorigin asset requests; every
  // cached URL here is same-origin and content-hashed, so URL match is safe
  e.respondWith(caches.match(req, { ignoreVary: true }).then((hit) => hit ?? fetch(req)))
})

// a notification (state/notify.ts) was clicked: bring the app up on that card
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const { board, card } = e.notification.data || {}
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const tab = list.find((c) => c.focused) || list[0]
      if (!tab) return self.clients.openWindow(board ? './#/b/' + board : './')
      tab.postMessage({ lawha: 'open', board, card })
      return tab.focus()
    }),
  )
})
`,
      })
    },
  }
}

/**
 * Inline the bundle and stylesheet into one self-contained lawha.html that
 * runs from a double-click (file://) — a distribution channel that needs no
 * git, no server, and no install, and can be passed around on a USB stick.
 * PWA tags are stripped: service workers and manifests do not work (and just
 * produce console errors) on file://.
 */
function singleFile(): Plugin {
  return {
    name: 'single-file',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(/\s*<!-- pwa:start -->[\s\S]*?<!-- pwa:end -->/, '')
    },
    closeBundle() {
      const dir = 'dist-single'
      let html = readFileSync(join(dir, 'index.html'), 'utf8')
      html = html.replace(
        /<script type="module"[^>]*src="\.?\/?(assets\/[^"]+)"[^>]*><\/script>/,
        (_, asset: string) =>
          `<script type="module">${readFileSync(join(dir, asset), 'utf8')}</script>`,
      )
      html = html.replace(
        /<link rel="stylesheet"[^>]*href="\.?\/?(assets\/[^"]+)"[^>]*>/,
        (_, asset: string) => `<style>${readFileSync(join(dir, asset), 'utf8')}</style>`,
      )
      writeFileSync(join(dir, 'lawha.html'), html)
      rmSync(join(dir, 'assets'), { recursive: true, force: true })
      rmSync(join(dir, 'index.html'))
    },
  }
}

export default defineConfig({
  base: SINGLE_FILE ? './' : (env?.BASE_PATH ?? '/'),
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [react(), injectCsp(), ...(SINGLE_FILE ? [singleFile()] : [serviceWorker()])],
  build: SINGLE_FILE
    ? {
        outDir: 'dist-single',
        cssCodeSplit: false,
        assetsInlineLimit: 1024 * 1024 * 100,
        modulePreload: false,
        // lawha.html is the only artifact — manifest/icons/sw are hosted-only
        copyPublicDir: false,
      }
    : undefined,
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
