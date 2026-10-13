import { getEngine, navigate, setWorkspace, useApp } from '../state/store'
import { createWorkspace } from '../state/actions'
import { useT } from './i18n'
import { LangPicker } from './LangPicker'
import { NewThing } from './NewThing'
import { PeerStatus } from './PeerStatus'
import { SideBoards } from './SideBoards'

export function Sidebar() {
  const t = useT()
  const route = useApp((s) => s.route)
  const ws = useApp((s) => s.ws)
  useApp((s) => s.version)
  const engine = getEngine()
  const workspaces = engine.workspaces()
  const wsView = ws ? engine.view(ws) : null
  const openId = route.name === 'board' || route.name === 'members' ? route.id : null

  return (
    <aside className="sidebar">
      <div className="side-head">
        <button className="wordmark" onClick={() => navigate({ name: 'home' })}>
          {t('brand')}
        </button>
      </div>

      <label className="ws-switch">
        <span className="sr-only">{t('workspace')}</span>
        <select
          value={ws ?? ''}
          onChange={(e) => {
            const v = e.target.value
            if (v === '__new') return
            setWorkspace(v || null)
            navigate({ name: 'home' })
          }}
        >
          <option value="">{t('personal')}</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name || t('unnamedWorkspace')}
            </option>
          ))}
        </select>
      </label>
      {ws && (
        <button
          className={`side-link ${route.name === 'members' && route.id === ws ? 'active' : ''}`}
          onClick={() => navigate({ name: 'members', id: ws })}
        >
          {t('coworkers', { n: wsView?.members.length ?? 0 })}
        </button>
      )}

      <nav className="side-boards" aria-label={t('boards')}>
        <SideBoards ws={ws} openId={openId} />
      </nav>

      <div className="side-foot">
        <NewThing label={t('newWorkspace')} placeholder={t('companyName')} onCreate={(name) => void createWorkspace(name)} />
        <button className={`side-link ${route.name === 'contacts' ? 'active' : ''}`} onClick={() => navigate({ name: 'contacts' })}>
          {t('navContacts')}
        </button>
        <button className={`side-link ${route.name === 'security' ? 'active' : ''}`} onClick={() => navigate({ name: 'security' })}>
          {t('navKeys')}
        </button>
        <div className="side-meta">
          <PeerStatus />
          <LangPicker />
        </div>
      </div>
    </aside>
  )
}
