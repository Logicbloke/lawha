import { useEffect, useRef, useState } from 'react'
import { LABEL_COLORS, type BoardView, type Label, type LabelColor } from '../core/board'
import { setLabel } from '../state/actions'
import { byName } from './CardFields'
import { useT } from './i18n'

/** The labels cards on this board can carry; anyone who can edit manages them. */
export function LabelSettings({ view, onDone }: { view: BoardView; onDone(): void }) {
  const t = useT()
  const all = [...view.labels.values()].sort(byName)
  const live = all.filter((l) => !l.archived)
  const archived = all.filter((l) => l.archived)
  const [name, setName] = useState('')
  // until one is picked, a new label starts in a color no other label has yet
  const [picked, setPicked] = useState<LabelColor | null>(null)
  const taken = new Set(live.map((l) => l.color))
  const color = picked ?? LABEL_COLORS.find((c) => c !== 'gray' && !taken.has(c)) ?? 'gray'

  return (
    <div className="stack">
      <h2>{t('labels')}</h2>
      <p className="hint">{t('labelsHint')}</p>
      {live.length > 0 ? (
        <ul className="label-defs">
          {live.map((l) => (
            <LabelRow key={l.id} board={view.id} label={l} />
          ))}
        </ul>
      ) : (
        <p className="muted">{t('noLabelsYet')}</p>
      )}

      <form
        className="new-label"
        onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim()) return
          void setLabel(view.id, { name: name.trim(), color })
          setName('')
          setPicked(null)
        }}
      >
        <input
          className={`c-${color}`}
          value={name}
          maxLength={80}
          placeholder={t('newLabel')}
          aria-label={t('newLabel')}
          onChange={(e) => setName(e.target.value)}
        />
        <Swatches value={color} label={t('labelColor')} onChange={setPicked} />
        <button className="primary" disabled={!name.trim()}>
          {t('addLabel')}
        </button>
      </form>

      {archived.length > 0 && (
        <>
          <h3>{t('archivedLabels')}</h3>
          <ul className="archive-list">
            {archived.map((l) => (
              <li key={l.id}>
                <span className={`label-chip c-${l.color}`}>{l.name}</span>
                <button onClick={() => void setLabel(view.id, { ...l, archived: false })}>{t('restore')}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="row">
        <button onClick={onDone}>{t('done')}</button>
      </div>
    </div>
  )
}

function LabelRow({ board, label }: { board: string; label: Label }) {
  const t = useT()
  const ref = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(label.name)
  useEffect(() => {
    if (document.activeElement !== ref.current) setName(label.name)
  }, [label.name])

  const rename = () => {
    const n = name.trim()
    if (!n) setName(label.name)
    else if (n !== label.name) void setLabel(board, { ...label, name: n })
  }

  return (
    <li className="label-def">
      <input
        ref={ref}
        className={`c-${label.color}`}
        value={name}
        maxLength={80}
        aria-label={t('labelName')}
        onChange={(e) => setName(e.target.value)}
        onBlur={rename}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <Swatches
        value={label.color}
        label={t('changeColor', { name: label.name })}
        onChange={(color) => color !== label.color && void setLabel(board, { ...label, color })}
      />
      <button className="link" onClick={() => void setLabel(board, { ...label, archived: true })}>
        {t('archive')}
      </button>
    </li>
  )
}

function Swatches({ value, label, onChange }: { value: LabelColor; label: string; onChange(c: LabelColor): void }) {
  const t = useT()
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {LABEL_COLORS.map((c) => (
        <button
          type="button"
          key={c}
          role="radio"
          aria-checked={value === c}
          aria-label={t(`color_${c}`)}
          title={t(`color_${c}`)}
          className={`swatch c-${c} ${value === c ? 'on' : ''}`}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  )
}
