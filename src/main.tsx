import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
import { initApp, setOnReady } from './state/store'
import { startNetwork } from './state/network'
import './ui/styles.css'

// Clickjacking guard: frame-ancestors cannot be delivered via <meta> CSP, so
// on plain static hosting nothing stops a hostile page from framing the app
// and overlaying its buttons. Refuse to run framed.
if (window.self !== window.top) {
  throw new Error('lawha refuses to run inside a frame')
}

setOnReady(startNetwork)
void initApp()

// PWA: sw.js is emitted only by the hosted production build; dev has no SW
// and the single-file build runs from file://, where SWs are unavailable.
if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {})
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
