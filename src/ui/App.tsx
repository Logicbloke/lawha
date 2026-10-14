import { useEffect, useState } from 'react'
import { useApp } from '../state/store'
import { useT } from './i18n'
import { Onboarding } from './Onboarding'
import { Sidebar } from './Sidebar'
import { Home } from './Home'
import { BoardScreen } from './BoardScreen'
import { MembersPanel } from './MembersPanel'
import { Contacts } from './Contacts'
import { JoinBoard } from './JoinBoard'
import { Security } from './Security'
import { UpdateBanner } from './UpdateBanner'
import { UpdateToast } from './UpdateToast'
import { Toasts } from './Toasts'

function Main() {
  const route = useApp((s) => s.route)
  switch (route.name) {
    case 'board':
      return <BoardScreen key={route.id} id={route.id} />
    case 'members':
      return <MembersPanel key={route.id} id={route.id} />
    case 'contacts':
      return <Contacts />
    case 'security':
      return <Security />
    case 'join':
      return <JoinBoard code={route.code} />
    default:
      return <Home />
  }
}

/**
 * `details.menu` popups close on a click elsewhere or on Escape (which then
 * closes only the menu, not a dialog behind it). Registered before any
 * dialog, so this listener runs first.
 */
function useMenuDismiss(): void {
  useEffect(() => {
    const open = () => [...document.querySelectorAll<HTMLDetailsElement>('details.menu[open]')]
    const onPointer = (e: PointerEvent) => {
      for (const d of open()) if (!(e.target instanceof Node && d.contains(e.target))) d.removeAttribute('open')
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const menus = open()
      if (menus.length === 0) return
      for (const d of menus) d.removeAttribute('open')
      menus[0]!.querySelector('summary')?.focus()
      e.stopImmediatePropagation()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [])
}

export function App() {
  const phase = useApp((s) => s.phase)
  const identity = useApp((s) => s.identity)
  const route = useApp((s) => s.route)
  const t = useT()
  const [drawer, setDrawer] = useState(false)
  useMenuDismiss()

  // the drawer closes on navigation (phone layout)
  useEffect(() => setDrawer(false), [route])

  if (phase !== 'ready' || !identity)
    return (
      <>
        <Onboarding phase={phase} />
        <UpdateToast />
      </>
    )

  return (
    <div className={`app ${drawer ? 'drawer-open' : ''}`}>
      <UpdateBanner />
      <button className="drawer-toggle" aria-label={t('menu')} aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path d="M2 4h14M2 9h14M2 14h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
      <Sidebar />
      <div className="scrim" onClick={() => setDrawer(false)} />
      <main className="main">
        <Main />
      </main>
      <Toasts />
      <UpdateToast />
    </div>
  )
}
