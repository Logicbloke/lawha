import { useState } from 'react'
import type { BoardView } from '../core/board'
import { RANK } from '../core/types'
import { archiveColumn, leaveBoard, setMyName, updateCard } from '../state/actions'
import { me } from '../state/store'
import { Modal } from './CardDetail'
import { useT } from './i18n'

/** Board-level actions: rename, your display name here, archive, leave. */
export function BoardMenu({ view, onRename }: { view: BoardView; onRename(): void }) {
  const t = useT()
  const [panel, setPanel] = useState<'name' | 'archive' | null>(null)
  const [name, setName] = useState(view.profiles.get(me().pub) ?? '')
  const close = (e: React.MouseEvent) => (e.currentTarget.closest('details') as HTMLDetailsElement).removeAttribute('open')
  const isAdmin = RANK[view.myRole] >= RANK.admin
  const canEdit = RANK[view.myRole] >= RANK.editor

  return (
    <>
      <details className="menu">
        <summary aria-label={t('boardMenu')}>
          <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="3" cy="8" r="1.5" fill="currentColor" />
            <circle cx="8" cy="8" r="1.5" fill="currentColor" />
            <circle cx="13" cy="8" r="1.5" fill="currentColor" />
          </svg>
        </summary>
        <div className="menu-pop end">
          {isAdmin && (
            <button onClick={(e) => (close(e), onRename())}>{t('renameBoard')}</button>
          )}
          <button onClick={(e) => (close(e), setPanel('name'))}>{t('myNameHere')}</button>
          <button onClick={(e) => (close(e), setPanel('archive'))}>
            {t('archivedItems', { n: view.archivedCards.length + view.archivedColumns.length })}
          </button>
          {view.myRole !== 'owner' && (
            <button
              className="danger"
              onClick={(e) => {
                close(e)
                if (confirm(t('leaveConfirm'))) void leaveBoard(view.id)
              }}
            >
              {t('leaveBoard')}
            </button>
          )}
        </div>
      </details>

      {panel === 'name' && (
        <Modal label={t('myNameHere')} onClose={() => setPanel(null)}>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault()
              void setMyName(view.id, name.trim())
              setPanel(null)
            }}
          >
            <h2>{t('myNameHere')}</h2>
            <p className="hint">{t('myNameHint')}</p>
            <input autoFocus value={name} maxLength={80} aria-label={t('displayName')} onChange={(e) => setName(e.target.value)} />
            <button className="primary">{t('save')}</button>
          </form>
        </Modal>
      )}

      {panel === 'archive' && (
        <Modal label={t('archive')} onClose={() => setPanel(null)}>
          <div className="stack">
            <h2>{t('archive')}</h2>
            {view.archivedColumns.length > 0 && <h3>{t('columns')}</h3>}
            <ul className="archive-list">
              {view.archivedColumns.map((c) => (
                <li key={c.id}>
                  <span>{c.name}</span>
                  {canEdit && <button onClick={() => void archiveColumn(view.id, c.id, false)}>{t('restore')}</button>}
                </li>
              ))}
            </ul>
            {view.archivedCards.length > 0 && <h3>{t('cards')}</h3>}
            <ul className="archive-list">
              {view.archivedCards.map((c) => (
                <li key={c.id}>
                  <span>{c.title}</span>
                  {canEdit && <button onClick={() => void updateCard(view.id, c.id, { archived: false })}>{t('restore')}</button>}
                </li>
              ))}
            </ul>
            {view.archivedCards.length + view.archivedColumns.length === 0 && <p className="muted">{t('nothingArchived')}</p>}
          </div>
        </Modal>
      )}
    </>
  )
}
