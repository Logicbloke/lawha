import { useState } from 'react'
import { getEngine, navigate, useApp } from '../state/store'
import { createBoard } from '../state/actions'
import { useBoardIds } from './hooks'
import { useT } from './i18n'

/** Boards of the selected workspace as a grid, with an inline "new board". */
export function Home() {
  const t = useT()
  const ws = useApp((s) => s.ws)
  const ids = useBoardIds(ws)
  const engine = getEngine()
  const wsView = ws ? engine.view(ws) : null
  const [name, setName] = useState('')

  return (
    <div className="home">
      <header className="home-head">
        <h1>{ws ? wsView?.name || t('unnamedWorkspace') : t('personalBoards')}</h1>
        <p className="lede">{ws ? t('homeCompanyLede') : t('homePersonalLede')}</p>
      </header>
      <ul className="board-grid">
        {ids.map((id) => {
          const v = engine.view(id)
          const counts = v ? v.columns.map((c) => v.byColumn.get(c.id)?.length ?? 0) : []
          const total = counts.reduce((a, b) => a + b, 0)
          return (
            <li key={id}>
              <button className="board-tile" onClick={() => navigate({ name: 'board', id })}>
                <span className="board-tile-name">{engine.boardName(id) || t('untitledBoard')}</span>
                {v && v.myRole !== 'none' ? (
                  <>
                    <span className="board-tile-bars" aria-hidden="true">
                      {counts.map((n, i) => (
                        <span key={i} style={{ flexGrow: Math.max(n, 0.3) }} />
                      ))}
                    </span>
                    <span className="board-tile-meta">
                      {t('nCards', { n: total })}, {t('nMembers', { n: v.members.length })}
                    </span>
                  </>
                ) : (
                  <span className="board-tile-meta">{t('waitingForAccess')}</span>
                )}
              </button>
            </li>
          )
        })}
        <li>
          <form
            className="board-tile new"
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim()) void createBoard(name.trim(), ws)
            }}
          >
            <label htmlFor="new-board-name">{t('newBoard')}</label>
            <input
              id="new-board-name"
              value={name}
              maxLength={80}
              placeholder={t('boardName')}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="primary" disabled={!name.trim()}>
              {t('create')}
            </button>
          </form>
        </li>
      </ul>
    </div>
  )
}
