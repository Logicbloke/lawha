import { applyUpdate, dismissUpdate, useSwUpdate } from '../state/swUpdate'
import { useT } from './i18n'

/** Offered once a newer deploy has taken over the service worker. */
export function UpdateToast() {
  const t = useT()
  const ready = useSwUpdate((s) => s.ready)
  if (!ready) return null
  return (
    <div className="update-toast" role="status">
      <span>{t('updateReady')}</span>
      <button className="primary" onClick={applyUpdate}>
        {t('updateNow')}
      </button>
      <button className="update-toast-close" onClick={dismissUpdate} aria-label={t('updateDismiss')}>
        <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
