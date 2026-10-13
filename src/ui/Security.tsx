import { useEffect, useState } from 'react'
import { exportIdentity } from '../core/identity'
import { endSession, identityEncrypted, me, sessionExpiry, useApp } from '../state/store'
import { useT } from './i18n'
import { QrCode } from './QrCode'

export function Security() {
  const identity = me()
  const lang = useApp((s) => s.lang)
  const t = useT()
  const [showBackup, setShowBackup] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const [encrypted, setEncrypted] = useState(false)
  const [expiry, setExpiry] = useState<number | null>(null)

  useEffect(() => {
    void identityEncrypted().then(setEncrypted)
    void sessionExpiry().then(setExpiry)
  }, [])

  return (
    <div className="security">
      <h1>{t('secTitle')}</h1>

      <section className="panel">
        <h2>{t('secBackupTitle')}</h2>
        <p>{t('secBackupBody')}</p>
        {showBackup ? (
          <>
            <code className="backup" dir="ltr">
              {exportIdentity(identity)}
            </code>
            {/* The QR is a second deliberate step: it can be captured silently
                from a screenshot or across a room, unlike text you must read. */}
            {showQr ? (
              <div className="qr-block">
                <p className="error">{t('qrPrivWarn')}</p>
                <QrCode value={exportIdentity(identity)} />
              </div>
            ) : (
              <button onClick={() => setShowQr(true)}>{t('qrPrivReveal')}</button>
            )}
          </>
        ) : (
          <button onClick={() => setShowBackup(true)}>{t('secReveal')}</button>
        )}
      </section>

      {encrypted && (
        <section className="panel">
          <h2>{t('secSessionTitle')}</h2>
          {expiry ? (
            <>
              <p>{t('secSessionActive', { when: new Date(expiry).toLocaleString(lang) })}</p>
              <button onClick={() => void endSession()}>{t('secSessionEnd')}</button>
            </>
          ) : (
            <p>{t('secSessionInactive')}</p>
          )}
        </section>
      )}

      <section className="panel">
        <h2>{t('secProtectsTitle')}</h2>
        <ul>
          <li>{t('secP1')}</li>
          <li>{t('secP2')}</li>
          <li>{t('secP3')}</li>
          <li>{t('secP4')}</li>
        </ul>
        <h2>{t('secNotTitle')}</h2>
        <ul>
          <li>
            <b>{t('secN1')}</b>
          </li>
          <li>{t('secN2')}</li>
          <li>{t('secN3')}</li>
          <li>{t('secN4')}</li>
          <li>{t('secN5')}</li>
        </ul>
      </section>

      <p className="app-version">
        {t('secVersion')} <bdi dir="ltr">{__APP_VERSION__}</bdi>
      </p>
    </div>
  )
}
