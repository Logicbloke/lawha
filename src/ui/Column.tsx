import { useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { BoardView, Card, Column as Col } from '../core/board'
import { addCard, archiveColumn, moveColumn, renameColumn, setColumnWip } from '../state/actions'
import { CardItem } from './CardItem'
import { useT } from './i18n'

interface Props {
  view: BoardView
  column: Col
  cards: Card[]
  canEdit: boolean
  selection: string[]
  hidden: Set<string>
  onOpen(id: string): void
  onToggle(id: string, range: boolean): void
  dir: 'ltr' | 'rtl'
}

function Composer({ board, col }: { board: string; col: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  if (!open) {
    return (
      <button className="add-card" onClick={() => setOpen(true)}>
        {t('addCard')}
      </button>
    )
  }
  const submit = () => {
    const v = title.trim()
    if (v) void addCard(board, col, v)
    setTitle('')
  }
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <textarea
        autoFocus
        value={title}
        maxLength={200}
        rows={2}
        placeholder={t('cardTitlePlaceholder')}
        aria-label={t('cardTitlePlaceholder')}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
          if (e.key === 'Escape') setOpen(false)
        }}
      />
      <div className="row">
        <button className="primary" disabled={!title.trim()}>
          {t('addCard')}
        </button>
        <button type="button" className="link" onClick={() => setOpen(false)}>
          {t('done')}
        </button>
      </div>
    </form>
  )
}

function ColumnMenu({ view, column, onRename }: { view: BoardView; column: Col; onRename(): void }) {
  const t = useT()
  const index = view.columns.findIndex((c) => c.id === column.id)
  const close = (e: React.MouseEvent) => (e.currentTarget.closest('details') as HTMLDetailsElement).removeAttribute('open')
  return (
    <details className="menu">
      <summary aria-label={t('columnMenu', { name: column.name })}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="3" cy="8" r="1.5" fill="currentColor" />
          <circle cx="8" cy="8" r="1.5" fill="currentColor" />
          <circle cx="13" cy="8" r="1.5" fill="currentColor" />
        </svg>
      </summary>
      <div className="menu-pop">
        <button
          onClick={(e) => {
            close(e)
            onRename()
          }}
        >
          {t('rename')}
        </button>
        <button
          onClick={(e) => {
            close(e)
            const raw = prompt(t('wipPrompt'), column.wip ? String(column.wip) : '')
            if (raw === null) return
            const n = parseInt(raw, 10)
            void setColumnWip(view.id, column.id, Number.isFinite(n) && n > 0 ? Math.min(n, 999) : null)
          }}
        >
          {t('wipLimit')}
        </button>
        <button
          disabled={index <= 0}
          onClick={(e) => {
            close(e)
            void moveColumn(view.id, column.id, index - 1)
          }}
        >
          {t('moveEarlier')}
        </button>
        <button
          disabled={index >= view.columns.length - 1}
          onClick={(e) => {
            close(e)
            void moveColumn(view.id, column.id, index + 1)
          }}
        >
          {t('moveLater')}
        </button>
        <button
          className="danger"
          onClick={(e) => {
            close(e)
            void archiveColumn(view.id, column.id, true)
          }}
        >
          {t('archiveColumn')}
        </button>
      </div>
    </details>
  )
}

export function Column({ view, column, cards, canEdit, selection, hidden, onOpen, onToggle, dir }: Props) {
  const t = useT()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(column.name)
  const sortable = useSortable({ id: `col:${column.id}`, data: { type: 'column' }, disabled: !canEdit })
  const drop = useDroppable({ id: `drop:${column.id}`, data: { type: 'column-body', col: column.id } })
  const visible = cards.filter((c) => !hidden.has(c.id))
  const over = column.wip !== null && visible.length > column.wip

  return (
    <section
      ref={sortable.setNodeRef}
      style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }}
      className={`column ${sortable.isDragging ? 'placeholder' : ''}`}
      dir={dir}
      aria-label={column.name}
    >
      <header className="column-head">
        {renaming ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim() && name.trim() !== column.name) void renameColumn(view.id, column.id, name.trim())
              setRenaming(false)
            }}
          >
            <input
              autoFocus
              value={name}
              maxLength={80}
              aria-label={t('columnName')}
              onChange={(e) => setName(e.target.value)}
              onBlur={(e) => e.currentTarget.form?.requestSubmit()}
              onKeyDown={(e) => e.key === 'Escape' && setRenaming(false)}
            />
          </form>
        ) : (
          <h2 className="column-name" onDoubleClick={() => canEdit && (setName(column.name), setRenaming(true))}>
            {canEdit ? (
              <span className="col-handle" {...sortable.attributes} {...sortable.listeners} aria-roledescription={t('dndColumn')}>
                {column.name}
              </span>
            ) : (
              column.name
            )}
          </h2>
        )}
        <span className={`column-count ${over ? 'over' : ''}`} title={column.wip ? t('wipLimit') : undefined}>
          {visible.length}
          {column.wip !== null && <span className="wip">/{column.wip}</span>}
        </span>
        {canEdit && <ColumnMenu view={view} column={column} onRename={() => (setName(column.name), setRenaming(true))} />}
      </header>
      <SortableContext items={visible.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <ul ref={drop.setNodeRef} className={`cards ${drop.isOver ? 'drop-over' : ''}`}>
          {visible.map((c) => (
            <CardItem
              key={c.id}
              card={c}
              view={view}
              selected={selection.includes(c.id)}
              selecting={selection.length > 0}
              disabled={!canEdit}
              onOpen={onOpen}
              onToggle={onToggle}
            />
          ))}
          {visible.length === 0 && <li className="cards-empty">{canEdit ? t('dropHere') : t('noCards')}</li>}
        </ul>
      </SortableContext>
      {canEdit && <Composer board={view.id} col={column.id} />}
    </section>
  )
}
