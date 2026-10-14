import { useId, useLayoutEffect, useRef, useState } from 'react'
import { MAX_COMMENT, type BoardView } from '../core/board'
import { mentionToken, splitMentions } from '../core/mentions'
import { addComment } from '../state/actions'
import { noteTyping } from '../state/looking'
import { me, toast } from '../state/store'
import { shortKey } from './hooks'
import { Identicon } from './Identicon'
import { useT } from './i18n'

interface Person {
  pub: string
  /** what is written after the @: the name, with the key when two share it */
  label: string
  name: string
}

const MAX_MATCHES = 8
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `@label` of each person picked becomes a mention token; the rest stays as typed. */
function encode(text: string, picked: Person[]): string {
  if (picked.length === 0) return text
  const byLabel = new Map(picked.map((p) => [p.label, p.pub]))
  // longest first, and not the start of a longer word: "@Sam" is not in "@Samantha"
  const alts = [...byLabel.keys()].sort((a, b) => b.length - a.length).map(escapeRe)
  const re = new RegExp(`@(${alts.join('|')})(?![\\p{L}\\p{N}])`, 'gu')
  return text.replace(re, (_, label: string) => mentionToken(label, byLabel.get(label)!))
}

/** The new comment box: typing @ offers the board's members, filtered by what follows. */
export function CommentBox({ view, cardId }: { view: BoardView; cardId: string }) {
  const t = useT()
  const listId = useId()
  const ref = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<Person[]>([])
  // where the @ being typed is, and what follows it so far
  const [query, setQuery] = useState<{ at: number; q: string } | null>(null)
  const [active, setActive] = useState(0)
  // where the caret goes once a picked name is in the box: before the next keystroke lands
  const caret = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (caret.current === null || !ref.current) return
    ref.current.setSelectionRange(caret.current, caret.current)
    caret.current = null
  }, [text])

  const mine = me().pub
  const others = view.members.filter((m) => m.pub !== mine)
  const nameOf = (pub: string) => view.profiles.get(pub) || shortKey(pub)
  const people: Person[] = others.map((m) => {
    const name = nameOf(m.pub)
    const shared = others.some((o) => o.pub !== m.pub && nameOf(o.pub) === name)
    return { pub: m.pub, name, label: shared ? `${name} (${shortKey(m.pub)})` : name }
  })
  const q = query?.q.toLocaleLowerCase() ?? ''
  const matches = query
    ? people
        .filter((p) => p.name.toLocaleLowerCase().includes(q) || p.pub.toLowerCase().startsWith(q))
        .sort((a, b) => Number(!a.name.toLocaleLowerCase().startsWith(q)) - Number(!b.name.toLocaleLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
        .slice(0, MAX_MATCHES)
    : []
  const open = matches.length > 0

  const lookForAt = (value: string, caret: number) => {
    const m = /(?:^|\s)@([^@\n]{0,40})$/.exec(value.slice(0, caret))
    setQuery(m ? { at: caret - m[1]!.length - 1, q: m[1]! } : null)
    setActive(0)
  }

  const pick = (p: Person) => {
    const ta = ref.current
    if (!ta || !query) return
    const insert = `@${p.label} `
    const next = text.slice(0, query.at) + insert + text.slice(ta.selectionStart)
    caret.current = query.at + insert.length
    setText(next)
    noteTyping(next)
    setPicked((list) => [...list.filter((x) => x.label !== p.label), p])
    setQuery(null)
  }

  const submit = () => {
    const body = encode(text.trim(), picked)
    if (!body) return
    if (body.length > MAX_COMMENT) {
      toast(t('errTooLarge'), 'error')
      return
    }
    void addComment(view.id, cardId, body)
    setText('')
    setPicked([])
    setQuery(null)
    noteTyping('')
  }

  return (
    <form
      className="comment-form"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="mention-wrap">
        <textarea
          ref={ref}
          value={text}
          rows={2}
          maxLength={MAX_COMMENT}
          placeholder={t('writeComment')}
          aria-label={t('writeComment')}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            setText(e.target.value)
            noteTyping(e.target.value)
            lookForAt(e.target.value, e.target.selectionStart)
          }}
          onSelect={(e) => lookForAt(e.currentTarget.value, e.currentTarget.selectionStart)}
          onBlur={() => setQuery(null)}
          onKeyDown={(e) => {
            if (!open) return
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              const step = e.key === 'ArrowDown' ? 1 : -1
              setActive((i) => (i + step + matches.length) % matches.length)
            } else if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              pick(matches[active] ?? matches[0]!)
            } else if (e.key === 'Escape') {
              // close the list, not the card
              e.preventDefault()
              e.stopPropagation()
              setQuery(null)
            }
          }}
        />
        {open && (
          <ul className="mention-list" role="listbox" id={listId} aria-label={t('mentionSomeone')}>
            {matches.map((p, i) => (
              <li
                key={p.pub}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'on' : ''}
                // keep the focus (and caret) in the textarea
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(p)
                }}
                onMouseEnter={() => setActive(i)}
              >
                <Identicon pub={p.pub} size={18} />
                <bdi>{p.name}</bdi>
                {p.name !== shortKey(p.pub) && <span className="mention-key">{shortKey(p.pub)}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button className="primary" disabled={!text.trim()}>
        {t('comment')}
      </button>
    </form>
  )
}

/** A comment's text, with mentions shown by the person's current name. */
export function CommentText({ text, view }: { text: string; view: BoardView }) {
  const mine = me().pub
  return (
    <p className="comment-text">
      {splitMentions(text).map((s, i) =>
        'pub' in s ? (
          <span key={i} className={`mention ${s.pub === mine ? 'me' : ''}`} title={shortKey(s.pub)}>
            @<bdi>{view.profiles.get(s.pub) || s.name}</bdi>
          </span>
        ) : (
          s.text
        ),
      )}
    </p>
  )
}
