import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { BoardView, Card } from '../core/board'
import { useApp } from '../state/store'
import { formatDue, isOverdue, useNow } from './hooks'
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
      {(card.due || card.comments.length > 0 || card.assignees.length > 0 || card.desc) && (
        <span className="card-meta">
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
        aria-roledescription={t('dndCard')}
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
