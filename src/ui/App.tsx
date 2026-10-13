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

export function App() {
  const phase = useApp((s) => s.phase)
  const identity = useApp((s) => s.identity)
  const route = useApp((s) => s.route)
  const t = useT()
  const [drawer, setDrawer] = useState(false)

  // the drawer closes on navigation (phone layout)
  useEffect(() => setDrawer(false), [route])

  if (phase !== 'ready' || !identity) return <Onboarding phase={phase} />

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
    </div>
  )
}
