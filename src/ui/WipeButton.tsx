import { useState } from 'react'
import { wipeThisBrowser } from '../state/store'
import { useT } from './i18n'

/** Delete everything Lawha keeps in this browser, after one confirmation. */
export function WipeButton() {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  return (
    <>
      <button
        className="danger"
        disabled={busy}
        onClick={() => {
          if (!confirm(t('wipeConfirm'))) return
          setBusy(true)
          wipeThisBrowser(() => setNote(t('wipeBlocked'))).catch(() => {
            setBusy(false)
            setNote(t('errGeneric'))
          })
        }}
      >
        {busy ? t('wipeBusy') : t('wipeButton')}
      </button>
      {note && (
        <p className="error" role="alert">
          {note}
        </p>
      )}
    </>
  )
}
