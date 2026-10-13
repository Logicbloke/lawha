import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Clickjacking guard: frame-ancestors cannot be delivered via <meta> CSP, so
// on plain static hosting nothing stops a hostile page from framing the app
// and overlaying its buttons. Refuse to run framed.
if (window.self !== window.top) {
  throw new Error('lawha refuses to run inside a frame')
}

// PWA: sw.js is emitted only by the hosted production build; dev has no SW
// and the single-file build runs from file://, where SWs are unavailable.
if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {})
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>لوحة · Lawha</h1>
      <p>Decentralized, end-to-end encrypted Kanban — coming online.</p>
    </main>
  </StrictMode>,
)
