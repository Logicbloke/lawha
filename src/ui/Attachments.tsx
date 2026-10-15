import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Attachment, BoardView, Card } from '../core/board'
import { isInlineImage, isInlineVideo } from '../core/sniff'
import { attachFiles, removeAttachment } from '../state/actions'
import { FileError, loadFile, saveFile, thumbUrl, useAttachmentState, useUploads } from '../state/attachments'
import { toast, useApp } from '../state/store'
import { formatBytes, formatRelative, shortKey, useNow } from './hooks'
import { useT } from './i18n'

/** asked around this long with no one holding it: say so */
const WAIT_MS = 4000
const NONE: Array<{ id: number; name: string }> = []

interface Shown {
  url: string
  blob: Blob
  kind: 'image' | 'video'
  at: Attachment
}

/** Files dropped on, or pasted into, the card dialog go on the card. */
export function useAttachTarget(board: string, card: string, enabled: boolean) {
  const [over, setOver] = useState(false)
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files')
  if (!enabled) return { over: false, props: {} }
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setOver(true)
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      },
      onDrop: (e: React.DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        setOver(false)
        void attachFiles(board, card, [...e.dataTransfer.files])
      },
      onPaste: (e: React.ClipboardEvent) => {
        const files = [...e.clipboardData.files]
        if (files.length === 0) return
        e.preventDefault()
        void attachFiles(board, card, files)
      },
    },
  }
}

export function Attachments({ view, card, canEdit }: { view: BoardView; card: Card; canEdit: boolean }) {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  const uploads = useUploads((s) => s[card.id]) ?? NONE
  const [shown, setShown] = useState<Shown | null>(null)
  if (!canEdit && card.attachments.length === 0) return null

  return (
    <section className="attachments">
      <h3>{t('attachments')}</h3>
      {(card.attachments.length > 0 || uploads.length > 0) && (
        <ul className="attach-list">
          {card.attachments.map((at) => (
            <AttachmentRow key={at.id} view={view} at={at} canEdit={canEdit} onShow={setShown} />
          ))}
          {uploads.map((u) => (
            <li key={`up-${u.id}`} className="attach-row pending">
              <span className="attach-thumb" aria-hidden="true">
                <span className="spinner" />
              </span>
              <span className="attach-info">
                <span className="attach-status">{t('attachSealing', { name: u.name })}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="attach-add">
          <button onClick={() => input.current?.click()}>{t('attachAdd')}</button>
          <span className="hint">{t('attachHint')}</span>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              if (files.length > 0) void attachFiles(view.id, card.id, files)
            }}
          />
        </div>
      )}
      {shown && <Lightbox shown={shown} onClose={() => setShown(null)} />}
    </section>
  )
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1) : ''
  return /^[\p{L}\p{N}]{1,5}$/u.test(ext) ? ext.toUpperCase() : ''
}

function AttachmentRow({
  view,
  at,
  canEdit,
  onShow,
}: {
  view: BoardView
  at: Attachment
  canEdit: boolean
  onShow(s: Shown): void
}) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const now = useNow()
  const { here, status } = useAttachmentState(at)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const thumb = useMemo(() => thumbUrl(at.thumb), [at.thumb])
  const ext = extOf(at.name)
  const who = view.profiles.get(at.by) || shortKey(at.by)

  let note = ''
  if (!here) {
    if (status && status.holders === 0 && status.askedAt > 0 && Date.now() - status.askedAt > WAIT_MS) note = t('attachWaiting')
    else if (status || busy) note = t('attachFetching', { pct: status ? Math.floor((status.got / status.n) * 100) : 0 })
    else note = t('attachNotHere')
  }

  const get = async (show: boolean) => {
    setBusy(true)
    try {
      const { blob, kind } = await loadFile(view.id, at)
      if (!mounted.current) return
      if (show && (isInlineImage(kind) || isInlineVideo(kind))) {
        onShow({ url: URL.createObjectURL(blob), blob, kind: isInlineVideo(kind) ? 'video' : 'image', at })
      } else {
        saveFile(blob, at.name)
      }
    } catch (e) {
      toast(t(e instanceof FileError && e.message === 'damaged' ? 'attachDamaged' : 'errGeneric'), 'error')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <li className="attach-row">
      <button className="attach-thumb" onClick={() => void get(true)} aria-label={t('attachOpen', { name: at.name })} disabled={busy}>
        {thumb ? <img src={thumb} alt="" /> : <span className="attach-ext">{ext || <FileGlyph />}</span>}
      </button>
      <span className="attach-info">
        <button className="attach-name link" onClick={() => void get(true)} disabled={busy} dir="auto">
          {at.name}
        </button>
        <span className="attach-meta">
          {formatBytes(at.size, lang)} · <bdi>{t('attachBy', { name: who })}</bdi> ·{' '}
          <time dateTime={new Date(at.ts).toISOString()}>{formatRelative(at.ts, now, lang)}</time>
        </span>
        {note && (
          <span className="attach-status" aria-live="polite">
            {note}
          </span>
        )}
      </span>
      <span className="attach-actions">
        <button onClick={() => void get(false)} disabled={busy}>
          {t('attachDownload')}
        </button>
        {canEdit && (
          <button
            className="danger"
            onClick={() => {
              if (confirm(t('attachRemoveConfirm', { name: at.name }))) void removeAttachment(view.id, at.card, at.id)
            }}
          >
            {t('attachRemove')}
          </button>
        )}
      </span>
    </li>
  )
}

function FileGlyph() {
  return (
    <svg width="18" height="22" viewBox="0 0 18 22" aria-hidden="true">
      <path d="M2 1h9l5 5v15H2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M11 1v5h5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

/** A picture or video full size, over the card. Escape closes it, not the card. */
function Lightbox({ shown, onClose }: { shown: Shown; onClose(): void }) {
  const t = useT()
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  useEffect(() => () => URL.revokeObjectURL(shown.url), [shown.url])
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={shown.at.name} onClick={onClose}>
      <figure onClick={(e) => e.stopPropagation()}>
        {shown.kind === 'image' ? (
          <img src={shown.url} alt={shown.at.name} />
        ) : (
          <video src={shown.url} controls autoPlay playsInline />
        )}
        <figcaption>
          <bdi className="lightbox-name">{shown.at.name}</bdi>
          <button onClick={() => saveFile(shown.blob, shown.at.name)}>{t('attachDownload')}</button>
          <button autoFocus onClick={onClose}>
            {t('close')}
          </button>
        </figcaption>
      </figure>
    </div>,
    document.body,
  )
}
