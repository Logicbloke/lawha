import { useEffect, useRef, useState } from 'react'
import { LABEL_COLORS, type BoardView, type LabelColor } from '../core/board'
import { RANK } from '../core/types'
import { getEngine, navigate, useApp } from '../state/store'
import { addComment, setLabel, updateCard } from '../state/actions'
import { formatRelative, shortKey, useNow } from './hooks'
import { CardFields } from './CardFields'
import { Identicon } from './Identicon'
import { useT } from './i18n'

interface Props {
  view: BoardView
  cardId: string
  onClose(): void
  onMove(id: string): void
}

/** Modal dialog with focus kept inside and Escape to close. */
export function Modal({ label, onClose, children, wide }: { label: string; onClose(): void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  // callers pass inline closures: read the latest one through a ref so the
  // effect below runs once per open, not on every parent render (re-running it
  // pulled focus out of the field being typed in)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })
  // what had focus before opening; captured at first render, before an
  // autoFocus field inside takes it
  const [prev] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current()
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [prev])
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        ref={ref}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

export function CardDetail({ view, cardId, onClose, onMove }: Props) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const now = useNow()
  const card = view.cards.get(cardId)!
  const canEdit = RANK[view.myRole] >= RANK.editor && card.movedTo === null
  const [title, setTitle] = useState(card.title)
  const [desc, setDesc] = useState(card.desc)
  const [comment, setComment] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newColor, setNewColor] = useState<LabelColor>('blue')

  // keep the draft in step with remote edits unless the field is being typed in
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (document.activeElement !== titleRef.current) setTitle(card.title)
    if (document.activeElement !== descRef.current) setDesc(card.desc)
  }, [card.title, card.desc])

  const labels = [...view.labels.values()].filter((l) => !l.archived)
  const col = view.columns.find((c) => c.id === card.col)
  const nameOf = (pub: string) => view.profiles.get(pub) || shortKey(pub)
  const toggleIn = (list: string[], x: string) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x])
  const movedToName = card.movedTo ? getEngine().boardName(card.movedTo) : ''

  return (
    <Modal label={card.title} onClose={onClose} wide>
      <div className="detail">
        <div className="detail-main">
          {canEdit ? (
            <textarea
              ref={titleRef}
              className="detail-title"
              value={title}
              rows={1}
              maxLength={200}
              aria-label={t('cardTitle')}
              onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
              onBlur={() => title.trim() && title.trim() !== card.title && void updateCard(view.id, card.id, { title: title.trim() })}
            />
          ) : (
            <h2 className="detail-title">{card.title}</h2>
          )}
          <p className="detail-where">
            {card.movedTo
              ? t('movedToBoard', { board: movedToName || t('anotherBoard') })
              : card.archived
                ? t('archived')
                : t('inColumn', { column: col?.name ?? t('unsorted') })}
            {card.from && <> {t('movedFromBoard', { board: getEngine().boardName(card.from.board) || t('anotherBoard') })}</>}
          </p>
          {card.movedTo && card.editedAfterMove && <p className="notice warn">{t('editedAfterMove')}</p>}
          {card.movedTo && (
            <button className="link" onClick={() => navigate({ name: 'board', id: card.movedTo! })}>
              {t('openTargetBoard')}
            </button>
          )}

          <h3>{t('description')}</h3>
          {canEdit ? (
            <textarea
              ref={descRef}
              className="detail-desc"
              value={desc}
              rows={6}
              maxLength={5000}
              placeholder={t('descriptionPlaceholder')}
              aria-label={t('description')}
              onChange={(e) => setDesc(e.target.value)}
              onBlur={() => desc !== card.desc && void updateCard(view.id, card.id, { desc })}
            />
          ) : (
            <p className="detail-desc-text">{card.desc || t('noDescription')}</p>
          )}

          <CardFields view={view} card={card} canEdit={canEdit} />

          <h3>{t('comments')}</h3>
          <ul className="comments-list">
            {card.comments.map((c) => (
              <li key={c.id}>
                <Identicon pub={c.imported?.author ?? c.author} size={22} />
                <div>
                  <span className="comment-head">
                    <b>{c.imported ? c.imported.name || shortKey(c.imported.author) : nameOf(c.author)}</b>{' '}
                    <time dateTime={new Date(c.imported?.ts ?? c.ts).toISOString()}>
                      {formatRelative(c.imported?.ts ?? c.ts, now, lang)}
                    </time>
                  </span>
                  <p className="comment-text">{c.text}</p>
                </div>
              </li>
            ))}
            {card.comments.length === 0 && <li className="muted">{t('noComments')}</li>}
          </ul>
          {canEdit && (
            <form
              className="comment-form"
              onSubmit={(e) => {
                e.preventDefault()
                if (comment.trim()) void addComment(view.id, card.id, comment.trim())
                setComment('')
              }}
            >
              <textarea
                value={comment}
                rows={2}
                maxLength={4000}
                placeholder={t('writeComment')}
                aria-label={t('writeComment')}
                onChange={(e) => setComment(e.target.value)}
              />
              <button className="primary" disabled={!comment.trim()}>
                {t('comment')}
              </button>
            </form>
          )}
        </div>

        <aside className="detail-side">
          <h3>{t('labels')}</h3>
          <div className="label-picker">
            {labels.map((l) => (
              <button
                key={l.id}
                className={`label-chip c-${l.color} ${card.labels.includes(l.id) ? 'on' : ''}`}
                aria-pressed={card.labels.includes(l.id)}
                disabled={!canEdit}
                onClick={() => void updateCard(view.id, card.id, { labels: toggleIn(card.labels, l.id) })}
              >
                {l.name}
              </button>
            ))}
          </div>
          {canEdit && (
            <form
              className="new-label"
              onSubmit={(e) => {
                e.preventDefault()
                if (!newLabel.trim()) return
                void setLabel(view.id, { name: newLabel.trim(), color: newColor }).then((id) => {
                  if (id) void updateCard(view.id, card.id, { labels: [...card.labels, id] })
                })
                setNewLabel('')
              }}
            >
              <input
                value={newLabel}
                maxLength={80}
                placeholder={t('newLabel')}
                aria-label={t('newLabel')}
                onChange={(e) => setNewLabel(e.target.value)}
              />
              <div className="swatches" role="radiogroup" aria-label={t('labelColor')}>
                {LABEL_COLORS.map((c) => (
                  <button
                    type="button"
                    key={c}
                    role="radio"
                    aria-checked={newColor === c}
                    aria-label={t(`color_${c}`)}
                    className={`swatch c-${c} ${newColor === c ? 'on' : ''}`}
                    onClick={() => setNewColor(c)}
                  />
                ))}
              </div>
            </form>
          )}

          <h3>{t('assignees')}</h3>
          <ul className="assignee-picker">
            {view.members
              .filter((m) => m.role !== 'viewer' || card.assignees.includes(m.pub))
              .map((m) => (
                <li key={m.pub}>
                  <label>
                    <input
                      type="checkbox"
                      checked={card.assignees.includes(m.pub)}
                      disabled={!canEdit}
                      onChange={() => void updateCard(view.id, card.id, { assignees: toggleIn(card.assignees, m.pub) })}
                    />
                    <Identicon pub={m.pub} size={20} />
                    <span>{m.name || shortKey(m.pub)}</span>
                  </label>
                </li>
              ))}
          </ul>

          <h3>{t('dueDate')}</h3>
          <input
            type="date"
            value={card.due ?? ''}
            disabled={!canEdit}
            aria-label={t('dueDate')}
            onChange={(e) => void updateCard(view.id, card.id, { due: e.target.value || null })}
          />

          {RANK[view.myRole] >= RANK.editor && (
            <div className="detail-actions">
              {card.movedTo === null && (
                <button className="primary" onClick={() => onMove(card.id)}>
                  {t('moveTo')}
                </button>
              )}
              <button onClick={() => void updateCard(view.id, card.id, { archived: !card.archived })}>
                {card.archived ? t('restore') : t('archive')}
              </button>
            </div>
          )}
          <p className="detail-by">
            {t('createdBy', { name: nameOf(card.createdBy) })}{' '}
            <time dateTime={new Date(card.createdAt).toISOString()}>{formatRelative(card.createdAt, now, lang)}</time>
          </p>
        </aside>
      </div>
      <button className="modal-close" onClick={onClose} aria-label={t('close')}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </Modal>
  )
}
