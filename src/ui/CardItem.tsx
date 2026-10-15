import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { BoardView, Card } from '../core/board'
import { useApp } from '../state/store'
import { useViewers } from '../state/looking'
import { formatDue, isOverdue, shortKey, useNow } from './hooks'
import { Identicon } from './Identicon'
import { useT } from './i18n'
import { justDragged } from './BoardScreen'

interface Props {
  card: Card
  view: BoardView
  selected: boolean
  selecting: boolean
  disabled?: boolean
  onOpen(id: string): void
  onToggle(id: string, range: boolean): void
}

export function CardFace({ card, view, count }: { card: Card; view: BoardView; count?: number }) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const now = useNow()
  const labels = card.labels.map((l) => view.labels.get(l)).filter((l) => l && !l.archived)
  const viewers = useViewers(view.id, card.id)
  const viewedBy =
    viewers.length > 0
      ? t('viewedBy', { names: new Intl.ListFormat(lang).format(viewers.map((p) => view.profiles.get(p) || shortKey(p))) })
      : ''
  return (
    <>
      {labels.length > 0 && (
        <span className="card-labels">
          {labels.map((l) => (
            <span key={l!.id} className={`label-chip c-${l!.color}`} title={l!.name}>
              {l!.name}
            </span>
          ))}
        </span>
      )}
      <span className="card-title">{card.title}</span>
      {(card.due ||
        card.comments.length > 0 ||
        card.attachments.length > 0 ||
        card.assignees.length > 0 ||
        card.desc ||
        viewers.length > 0) && (
        <span className="card-meta">
          {viewers.length > 0 && (
            <span className="viewers" title={viewedBy} aria-label={viewedBy}>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <circle cx="8" cy="8" r="2" fill="currentColor" />
              </svg>
              {viewers.slice(0, 3).map((p) => (
                <Identicon key={p} pub={p} size={16} />
              ))}
            </span>
          )}
          {card.due && (
            <span className={`due ${isOverdue(card.due, now) ? 'overdue' : ''}`}>
              {formatDue(card.due, lang)}
            </span>
          )}
          {card.desc && <span className="has-desc" title={t('hasDescription')} aria-label={t('hasDescription')} />}
          {card.comments.length > 0 && (
            <span className="comments" aria-label={t('nComments', { n: card.comments.length })}>
              {card.comments.length}
            </span>
          )}
          {card.attachments.length > 0 && (
            <span className="attached" aria-label={t('nAttachments', { n: card.attachments.length })}>
              <svg width="11" height="13" viewBox="0 0 11 13" aria-hidden="true">
                <path
                  d="M8.5 6.2 5 9.7a2.1 2.1 0 0 1-3-3l4.1-4.1a1.4 1.4 0 0 1 2 2L4.3 8.4a.7.7 0 0 1-1-1l3.2-3.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
              {card.attachments.length}
            </span>
          )}
          <span className="assignees">
            {card.assignees.slice(0, 3).map((p) => (
              <Identicon key={p} pub={p} size={18} />
            ))}
          </span>
        </span>
      )}
      {count !== undefined && count > 1 && <span className="drag-count">{count}</span>}
    </>
  )
}

export function CardItem({ card, view, selected, selecting, disabled, onOpen, onToggle }: Props) {
  const t = useT()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: 'card' },
    disabled,
  })
  const style = { transform: CSS.Translate.toString(transform), transition }
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`card ${selected ? 'selected' : ''} ${isDragging ? 'placeholder' : ''}`}
      data-card={card.id}
    >
      <button
        className="card-body"
        {...attributes}
        {...listeners}
        // a viewer cannot drag the card but still opens it: not "disabled"
        aria-disabled={undefined}
        aria-describedby={disabled ? undefined : attributes['aria-describedby']}
        aria-roledescription={disabled ? undefined : t('dndCard')}
        aria-pressed={selecting ? selected : undefined}
        onClick={(e) => {
          if (justDragged()) return
          if (e.shiftKey || e.metaKey || e.ctrlKey || selecting) onToggle(card.id, e.shiftKey)
          else onOpen(card.id)
        }}
      >
        <CardFace card={card} view={view} />
      </button>
      <label className="card-check" title={t('select')}>
        <input
          type="checkbox"
          checked={selected}
          aria-label={t('selectCard', { title: card.title })}
          onChange={() => onToggle(card.id, false)}
        />
      </label>
    </li>
  )
}
