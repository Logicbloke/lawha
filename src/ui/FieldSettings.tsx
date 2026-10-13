import { useEffect, useRef, useState } from 'react'
import {
  FIELD_TYPES,
  LABEL_COLORS,
  MAX_OPTIONS,
  type BoardView,
  type FieldDef,
  type FieldType,
  type LabelColor,
} from '../core/board'
import { addFieldOption, createField, editField } from '../state/actions'
import { byName } from './CardFields'
import { useT, type TKey } from './i18n'

/** Admins define the fields (templates) cards on this board can carry. */
export function FieldSettings({ view, onDone }: { view: BoardView; onDone(): void }) {
  const t = useT()
  const [name, setName] = useState('')
  const [type, setType] = useState<FieldType>('text')
  const all = [...view.fields.values()].sort(byName)
  const live = all.filter((f) => !f.archived)
  const archived = all.filter((f) => f.archived)

  return (
    <div className="stack field-settings">
      <h2>{t('cardFields')}</h2>
      <p className="hint">{t('cardFieldsHint')}</p>
      {live.length > 0 ? (
        <ul className="field-defs">
          {live.map((f) => (
            <FieldDefRow key={f.id} board={view.id} def={f} />
          ))}
        </ul>
      ) : (
        <p className="muted">{t('noFieldsYet')}</p>
      )}

      <form
        className="new-field"
        onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim()) return
          void createField(view.id, name.trim(), type)
          setName('')
        }}
      >
        <input
          value={name}
          maxLength={80}
          placeholder={t('fieldName')}
          aria-label={t('fieldName')}
          onChange={(e) => setName(e.target.value)}
        />
        <select value={type} aria-label={t('fieldType')} onChange={(e) => setType(e.target.value as FieldType)}>
          {FIELD_TYPES.map((ft) => (
            <option key={ft} value={ft}>
              {t(`fieldType_${ft}` as TKey)}
            </option>
          ))}
        </select>
        <button className="primary" disabled={!name.trim()}>
          {t('addField')}
        </button>
      </form>

      {archived.length > 0 && (
        <>
          <h3>{t('archivedFields')}</h3>
          <ul className="archive-list">
            {archived.map((f) => (
              <li key={f.id}>
                <span>{f.name}</span>
                <button onClick={() => void editField(view.id, f.id, (d) => ({ ...d, archived: false }))}>{t('restore')}</button>
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

function FieldDefRow({ board, def }: { board: string; def: FieldDef }) {
  const t = useT()
  const ref = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(def.name)
  const [choice, setChoice] = useState('')
  useEffect(() => {
    if (document.activeElement !== ref.current) setName(def.name)
  }, [def.name])

  const rename = () => {
    const n = name.trim()
    if (!n) setName(def.name)
    else if (n !== def.name) void editField(board, def.id, (d) => ({ ...d, name: n }))
  }
  const nextColor = (c: LabelColor) => LABEL_COLORS[(LABEL_COLORS.indexOf(c) + 1) % LABEL_COLORS.length]!

  return (
    <li className="field-def">
      <div className="field-def-head">
        <input
          ref={ref}
          value={name}
          maxLength={80}
          aria-label={t('fieldName')}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span className="field-type">{t(`fieldType_${def.type}` as TKey)}</span>
        <button className="link" onClick={() => void editField(board, def.id, (d) => ({ ...d, archived: true }))}>
          {t('archive')}
        </button>
      </div>
      {def.type === 'choice' && (
        <div className="field-options">
          {def.options.map((o) => (
            <span key={o.id} className={`label-chip option-chip c-${o.color}`}>
              <button
                type="button"
                className="option-color"
                title={t('changeColor', { name: o.name })}
                aria-label={t('changeColor', { name: o.name })}
                onClick={() =>
                  void editField(board, def.id, (d) => ({
                    ...d,
                    options: d.options.map((x) => (x.id === o.id ? { ...x, color: nextColor(x.color) } : x)),
                  }))
                }
              />
              <span>{o.name}</span>
              <button
                type="button"
                className="option-remove"
                aria-label={t('removeNamed', { name: o.name })}
                onClick={() => {
                  if (!confirm(t('removeChoiceConfirm', { name: o.name }))) return
                  void editField(board, def.id, (d) => ({ ...d, options: d.options.filter((x) => x.id !== o.id) }))
                }}
              >
                <svg width="8" height="8" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                </svg>
              </button>
            </span>
          ))}
          {def.options.length < MAX_OPTIONS && (
            <form
              className="new-option"
              onSubmit={(e) => {
                e.preventDefault()
                if (!choice.trim()) return
                void addFieldOption(board, def.id, choice.trim())
                setChoice('')
              }}
            >
              <input
                value={choice}
                maxLength={80}
                placeholder={t('newChoice')}
                aria-label={t('newChoiceFor', { name: def.name })}
                onChange={(e) => setChoice(e.target.value)}
              />
              <button disabled={!choice.trim()}>{t('add')}</button>
            </form>
          )}
        </div>
      )}
    </li>
  )
}
