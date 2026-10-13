import { useState } from 'react'
import { getEngine, navigate, setWorkspace, useApp } from '../state/store'
import { createBoard, createWorkspace } from '../state/actions'
import { useBoardIds } from './hooks'
import { useT } from './i18n'
import { LangPicker } from './LangPicker'
import { PeerStatus } from './PeerStatus'

function NewThing({ placeholder, onCreate, label }: { placeholder: string; label: string; onCreate: (name: string) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  if (!open) {
    return (
      <button className="side-add" onClick={() => setOpen(true)}>
        <span aria-hidden="true">+</span> {label}
      </button>
    )
  }
  return (
    <form
      className="side-new"
      onSubmit={(e) => {
        e.preventDefault()
        if (!name.trim()) return
        onCreate(name.trim())
        setName('')
        setOpen(false)
      }}
    >
      <input
        autoFocus
        value={name}
        maxLength={80}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => !name && setOpen(false)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      />
    </form>
  )
}

export function Sidebar() {
  const t = useT()
  const route = useApp((s) => s.route)
  const ws = useApp((s) => s.ws)
  useApp((s) => s.version)
  const engine = getEngine()
  const boards = useBoardIds(ws)
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
        <h2 className="side-title">{t('boards')}</h2>
        {boards.length === 0 && <p className="side-empty">{t('noBoardsYet')}</p>}
        <ul>
          {boards.map((id) => {
            const name = engine.boardName(id)
            const v = engine.view(id)
            const waiting = !v || v.myRole === 'none'
            return (
              <li key={id}>
                <button
                  className={`side-board ${openId === id ? 'active' : ''}`}
                  onClick={() => navigate({ name: 'board', id })}
                  aria-current={openId === id ? 'page' : undefined}
                >
                  <span className="side-board-name" dir="auto">{name || t('untitledBoard')}</span>
                  {waiting && <span className="side-pending">{t('pending')}</span>}
                </button>
              </li>
            )
          })}
        </ul>
        <NewThing label={t('newBoard')} placeholder={t('boardName')} onCreate={(name) => void createBoard(name, ws)} />
        <button className="side-add" onClick={() => navigate({ name: 'join', code: '' })}>
          {t('joinWithInvite')}
        </button>
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
