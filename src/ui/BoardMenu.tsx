import { useState } from 'react'
import type { BoardView } from '../core/board'
import { RANK } from '../core/types'
import { archiveColumn, leaveBoard, placeBoard, setMyName, updateCard } from '../state/actions'
import { useGrouping } from '../state/categories'
import { setEagerLimit } from '../state/attachments'
import { EAGER_CHOICES, useEagerLimit } from '../state/filePrefs'
import { getEngine, me, useApp } from '../state/store'
import { Modal } from './CardDetail'
import { FieldSettings } from './FieldSettings'
import { formatBytes } from './hooks'
import { useT } from './i18n'
import { LabelSettings } from './LabelSettings'
import { NotifySettings } from './NotifySettings'

/** Board-level actions: rename, labels, fields, notifications, files kept here, your display name here, archive, leave. */
export function BoardMenu({ view, onRename }: { view: BoardView; onRename(): void }) {
  const t = useT()
  const [panel, setPanel] = useState<'name' | 'labels' | 'fields' | 'notify' | 'files' | 'category' | 'archive' | null>(null)
  const [name, setName] = useState(view.profiles.get(me().pub) ?? '')
  // the same grouping as the sidebar: the board's workspace, or this device for personal boards
  const ws = getEngine().wsOf(view.id)
  const grouping = useGrouping(ws)
  const [category, setCategory] = useState('')
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
          {canEdit && <button onClick={(e) => (close(e), setPanel('labels'))}>{t('labels')}</button>}
          {isAdmin && <button onClick={(e) => (close(e), setPanel('fields'))}>{t('cardFields')}</button>}
          {grouping.canManage && grouping.categories.length > 0 && (
            <button
              onClick={(e) => {
                close(e)
                setCategory(grouping.placeOf(view.id) ?? '')
                setPanel('category')
              }}
            >
              {t('category')}
            </button>
          )}
          <button onClick={(e) => (close(e), setPanel('notify'))}>{t('notifications')}</button>
          <button onClick={(e) => (close(e), setPanel('files'))}>{t('filesKeep')}</button>
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

      {panel === 'labels' && (
        <Modal label={t('labels')} onClose={() => setPanel(null)}>
          <LabelSettings view={view} onDone={() => setPanel(null)} />
        </Modal>
      )}

      {panel === 'fields' && (
        <Modal label={t('cardFields')} onClose={() => setPanel(null)}>
          <FieldSettings view={view} onDone={() => setPanel(null)} />
        </Modal>
      )}

      {panel === 'notify' && (
        <Modal label={t('notifications')} onClose={() => setPanel(null)}>
          <NotifySettings view={view} onDone={() => setPanel(null)} />
        </Modal>
      )}

      {panel === 'files' && (
        <Modal label={t('filesKeep')} onClose={() => setPanel(null)}>
          <FileSettings board={view.id} onDone={() => setPanel(null)} />
        </Modal>
      )}

      {panel === 'category' && (
        <Modal label={t('category')} onClose={() => setPanel(null)}>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault()
              void placeBoard(ws, view.id, category || null)
              setPanel(null)
            }}
          >
            <h2>{t('category')}</h2>
            <p className="hint">{ws ? t('categoryHintCompany') : t('categoryHintPersonal')}</p>
            <select autoFocus value={category} aria-label={t('category')} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{t('noCategory')}</option>
              {grouping.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
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

/** How big a file of this board this device fetches by itself; kept here, never sent. */
function FileSettings({ board, onDone }: { board: string; onDone(): void }) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const limit = useEagerLimit(board)
  const choices: number[] = EAGER_CHOICES.includes(limit as (typeof EAGER_CHOICES)[number]) ? [...EAGER_CHOICES] : [...EAGER_CHOICES, limit]
  return (
    <div className="stack file-settings">
      <h2>{t('filesKeep')}</h2>
      <p className="hint">{t('filesKeepHint')}</p>
      <fieldset>
        <legend className="sr-only">{t('filesKeep')}</legend>
        {choices.map((n) => (
          <label key={n} className="check-row">
            <input type="radio" name="files-keep" checked={limit === n} onChange={() => setEagerLimit(board, n)} />
            <span>{n === 0 ? t('filesKeepOff') : t('filesKeepUpTo', { size: formatBytes(n, lang) })}</span>
          </label>
        ))}
      </fieldset>
      <p className="hint">{t('filesLocal')}</p>
      <div className="row">
        <button onClick={onDone}>{t('done')}</button>
      </div>
    </div>
  )
}
