import { useEffect, useId, useRef, useState } from 'react'
import {
  MAX_FIELD_TEXT,
  MAX_URL,
  isHttpUrl,
  type BoardView,
  type Card,
  type FieldDef,
  type FieldEntry,
  type FieldValue,
} from '../core/board'
import { newId, setEntry } from '../state/actions'
import { useApp } from '../state/store'
import { formatDate, shortKey } from './hooks'
import { Identicon } from './Identicon'
import { useT, type TKey } from './i18n'

export const byName = (a: { id: string; name: string }, b: { id: string; name: string }) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)

/**
 * The values a card holds. Only the entries added to this card show; "Add
 * field" picks any field of the board, the same one as often as needed.
 */
export function CardFields({ view, card, canEdit }: { view: BoardView; card: Card; canEdit: boolean }) {
  const t = useT()
  // a value being added; its entry id is fixed up front so that changing it
  // again before the first write lands rewrites that entry, and the draft row
  // gives way the moment the entry shows up
  const [draft, setDraft] = useState<{ field: string; id: string } | null>(null)
  const defs = [...view.fields.values()].filter((f) => !f.archived).sort(byName)
  const draftDef = draft && !card.fields.some((e) => e.id === draft.id) ? view.fields.get(draft.field) : undefined
  if (!canEdit && card.fields.length === 0) return null

  const pick = (f: FieldDef) => {
    // a checkbox has no empty state: adding one adds it unticked
    if (f.type === 'checkbox') void setEntry(view.id, card.id, { field: f.id, value: false })
    else setDraft({ field: f.id, id: newId() })
  }

  return (
    <>
      <h3>{t('fields')}</h3>
      {(card.fields.length > 0 || draftDef) && (
        <ul className="entries">
          {card.fields.map((e) => (
            <EntryRow key={e.id} view={view} card={card.id} def={view.fields.get(e.field)!} entry={e} canEdit={canEdit} />
          ))}
          {draft && draftDef && (
            <EntryRow
              key={draft.id}
              view={view}
              card={card.id}
              def={draftDef}
              entry={null}
              draftId={draft.id}
              canEdit
              onDone={() => setDraft((d) => (d?.id === draft.id ? null : d))}
            />
          )}
        </ul>
      )}
      {canEdit &&
        (defs.length > 0 ? <AddField defs={defs} onPick={pick} /> : <p className="hint">{t('noFieldsDefined')}</p>)}
    </>
  )
}

function AddField({ defs, onPick }: { defs: FieldDef[]; onPick(f: FieldDef): void }) {
  const t = useT()
  const ref = useRef<HTMLDetailsElement>(null)
  return (
    <details className="menu add-entry" ref={ref}>
      <summary>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        {t('addField')}
      </summary>
      <div className="menu-pop">
        {defs.map((f) => (
          <button
            key={f.id}
            onClick={() => {
              ref.current?.removeAttribute('open')
              onPick(f)
            }}
          >
            <span>{f.name}</span>
            <span className="menu-note">{t(`fieldType_${f.type}` as TKey)}</span>
          </button>
        ))}
      </div>
    </details>
  )
}

interface RowProps {
  view: BoardView
  card: string
  def: FieldDef
  /** null: a value being added, written as `draftId` once it has one */
  entry: FieldEntry | null
  draftId?: string
  canEdit: boolean
  onDone?(): void
}

function EntryRow({ view, card, def, entry, draftId, canEdit, onDone }: RowProps) {
  const t = useT()
  const id = useId()
  const commit = (value: FieldValue) => {
    if (entry) {
      if (value !== entry.value) void setEntry(view.id, card, { id: entry.id, field: def.id, value })
    } else if (value !== null) {
      void setEntry(view.id, card, { id: draftId, field: def.id, value }).finally(onDone)
    } else {
      onDone?.()
    }
  }
  const remove = () => {
    if (entry) void setEntry(view.id, card, { id: entry.id, field: def.id, value: entry.value, removed: true })
    else onDone?.()
  }
  return (
    <li className="entry">
      {canEdit ? (
        <label className="entry-key" htmlFor={id}>
          {def.name}
        </label>
      ) : (
        <span className="entry-key">{def.name}</span>
      )}
      {canEdit ? (
        <ValueEditor id={id} view={view} def={def} value={entry?.value ?? null} draft={!entry} commit={commit} />
      ) : (
        <div className="entry-value view">
          <ValueView view={view} def={def} value={entry?.value ?? null} />
        </div>
      )}
      {canEdit && (
        <button className="entry-remove" aria-label={t('removeNamed', { name: def.name })} onClick={remove}>
          <svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </li>
  )
}

interface EditorProps {
  id: string
  view: BoardView
  def: FieldDef
  value: FieldValue
  draft: boolean
  commit(value: FieldValue): void
}

/** Grid cells of an editable row: the control, then an aside (link, color, avatar) so controls line up. */
function Cells({ control, aside }: { control: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <>
      <div className="entry-value">{control}</div>
      <span className="entry-aside">{aside}</span>
    </>
  )
}

function ValueEditor(props: EditorProps) {
  const t = useT()
  const { id, view, def, value, draft, commit } = props
  // leaving an untouched new value cancels it
  const cancelIfDraft = () => draft && commit(null)
  switch (def.type) {
    case 'text':
    case 'number':
    case 'url':
      return <TypedValue {...props} />
    case 'date':
      return (
        <Cells
          control={
            <input
              id={id}
              type="date"
              value={typeof value === 'string' ? value : ''}
              autoFocus={draft}
              onChange={(e) => commit(e.target.value || null)}
              onBlur={cancelIfDraft}
            />
          }
        />
      )
    case 'checkbox':
      return (
        <Cells control={<input id={id} type="checkbox" checked={value === true} onChange={(e) => commit(e.target.checked)} />} />
      )
    case 'choice': {
      const color = def.options.find((o) => o.id === value)?.color
      return (
        <Cells
          control={
            <select
              id={id}
              value={typeof value === 'string' ? value : ''}
              autoFocus={draft}
              onChange={(e) => commit(e.target.value || null)}
              onBlur={cancelIfDraft}
            >
              <option value="">{t('noValue')}</option>
              {def.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          }
          aside={color && <span className={`dot c-${color}`} aria-hidden="true" />}
        />
      )
    }
    case 'person': {
      const pub = typeof value === 'string' ? value : ''
      return (
        <Cells
          control={
            <select id={id} value={pub} autoFocus={draft} onChange={(e) => commit(e.target.value || null)} onBlur={cancelIfDraft}>
              <option value="">{t('noValue')}</option>
              {view.members.map((m) => (
                <option key={m.pub} value={m.pub}>
                  {m.name || shortKey(m.pub)}
                </option>
              ))}
              {pub && !view.members.some((m) => m.pub === pub) && (
                <option value={pub}>{view.profiles.get(pub) || shortKey(pub)}</option>
              )}
            </select>
          }
          aside={pub && <Identicon pub={pub} size={20} />}
        />
      )
    }
  }
}

/** Text, number and link: typed freely, saved on leaving the field or Enter. */
function TypedValue({ id, def, value, draft, commit }: EditorProps) {
  const t = useT()
  const ref = useRef<HTMLInputElement>(null)
  const shown = value === null ? '' : String(value)
  const [text, setText] = useState(shown)
  const [bad, setBad] = useState(false)
  // follow remote edits unless this field is being typed in
  useEffect(() => {
    if (document.activeElement !== ref.current) {
      setText(shown)
      setBad(false)
    }
  }, [shown])

  const save = (input: HTMLInputElement) => {
    // undefined: not a value of this type (a number input reads back empty on garbage)
    const s = text.trim()
    let v: FieldValue | undefined = s
    if (def.type === 'number' && input.validity.badInput) v = undefined
    else if (!s) v = null
    else if (def.type === 'number') v = Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : undefined
    else if (def.type === 'url') {
      const url = /^[a-z][a-z\d+.-]*:/i.test(s) ? s : `https://${s}`
      v = isHttpUrl(url) ? url : undefined
    }
    if (v === undefined) {
      setBad(true)
      return
    }
    setBad(false)
    if (typeof v === 'string' && v !== text) setText(v)
    commit(v)
  }

  return (
    <>
      <Cells
        control={
          <input
            ref={ref}
            id={id}
            type={def.type === 'number' ? 'number' : def.type === 'url' ? 'url' : 'text'}
            step={def.type === 'number' ? 'any' : undefined}
            dir={def.type === 'text' ? undefined : 'ltr'}
            value={text}
            maxLength={def.type === 'url' ? MAX_URL : MAX_FIELD_TEXT}
            placeholder={def.type === 'url' ? 'https://' : undefined}
            aria-invalid={bad}
            aria-describedby={bad ? `${id}-err` : undefined}
            autoFocus={draft}
            onChange={(e) => {
              setText(e.target.value)
              setBad(false)
            }}
            onBlur={(e) => save(e.currentTarget)}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        }
        aside={
          def.type === 'url' &&
          typeof value === 'string' &&
          isHttpUrl(value) && (
            <a className="entry-open" href={value} target="_blank" rel="noopener noreferrer" title={t('openLink')} aria-label={t('openLink')}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path
                  d="M5.5 2.5H2.5v9h9v-3M8 2h4v4M12 2L6.5 7.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </a>
          )
        }
      />
      {bad && (
        <p className="error entry-error" id={`${id}-err`}>
          {t(def.type === 'url' ? 'invalidUrl' : 'invalidNumber')}
        </p>
      )}
    </>
  )
}

/** Read-only value, for viewers and moved-card stubs. Text only; links only http(s). */
function ValueView({ view, def, value }: { view: BoardView; def: FieldDef; value: FieldValue }) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  if (value === null) return <span className="muted">{t('noValue')}</span>
  switch (def.type) {
    case 'number':
      return <span>{(value as number).toLocaleString(lang)}</span>
    case 'url':
      return isHttpUrl(value as string) ? (
        <a className="entry-link" href={value as string} target="_blank" rel="noopener noreferrer" dir="ltr">
          {(value as string).replace(/^https?:\/\//, '')}
        </a>
      ) : (
        <span>{String(value)}</span>
      )
    case 'date':
      return <span>{formatDate(value as string, lang)}</span>
    case 'choice': {
      const o = def.options.find((x) => x.id === value)
      return o ? <span className={`label-chip c-${o.color}`}>{o.name}</span> : null
    }
    case 'checkbox':
      return <input type="checkbox" checked={value === true} disabled aria-label={def.name} />
    case 'person':
      return (
        <span className="entry-choice">
          <Identicon pub={value as string} size={18} />
          {view.profiles.get(value as string) || shortKey(value as string)}
        </span>
      )
    default:
      return <span className="entry-text">{String(value)}</span>
  }
}
