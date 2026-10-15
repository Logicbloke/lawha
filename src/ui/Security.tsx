import { useEffect, useState } from 'react'
import { exportIdentity } from '../core/identity'
import { deviceCode } from '../state/devices'
import { restartNetwork } from '../state/network'
import { endSession, getEngine, identityEncrypted, me, sessionExpiry, toast, useApp } from '../state/store'
import { isTurnUrl, loadTurn, saveTurn } from '../state/turn'
import { useT } from './i18n'
import { QrCode } from './QrCode'
import { WipeButton } from './WipeButton'

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

      <section className="panel">
        <h2>{t('secDeviceTitle')}</h2>
        <p>
          {t('secDeviceBody')} <code dir="ltr">{deviceCode(getEngine().dev)}</code>
        </p>
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

      <TurnPanel />

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
          <li>{t('secN6')}</li>
        </ul>
      </section>

      <section className="panel">
        <h2>{t('wipeTitle')}</h2>
        <p>{t('wipeBody')}</p>
        <WipeButton />
      </section>

      <p className="app-version">
        {t('secVersion')} <bdi dir="ltr">{__APP_VERSION__}</bdi>
      </p>
    </div>
  )
}

function TurnPanel() {
  const t = useT()
  const [saved, setSaved] = useState(loadTurn)
  const [urls, setUrls] = useState(saved?.urls ?? '')
  const [username, setUsername] = useState(saved?.username ?? '')
  const [credential, setCredential] = useState(saved?.credential ?? '')
  const [bad, setBad] = useState(false)
  const apply = (next: typeof saved) => {
    saveTurn(next)
    setSaved(next)
    restartNetwork()
    toast(t('turnSaved'))
  }
  return (
    <section className="panel">
      <h2>{t('turnTitle')}</h2>
      <p>{t('turnBody')}</p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          if (!isTurnUrl(urls)) return setBad(true)
          apply({ urls: urls.trim(), username, credential })
        }}
      >
        <label className="field">
          <span>{t('turnUrl')}</span>
          <input
            dir="ltr"
            value={urls}
            placeholder="turn:turn.example.com:3478"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={bad || undefined}
            onChange={(e) => (setUrls(e.target.value), setBad(false))}
          />
        </label>
        {bad && <p className="error">{t('turnBadUrl')}</p>}
        <label className="field">
          <span>{t('turnUser')}</span>
          <input dir="ltr" value={username} autoComplete="off" spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('turnPass')}</span>
          <input dir="ltr" type="password" value={credential} autoComplete="new-password" onChange={(e) => setCredential(e.target.value)} />
        </label>
        <div className="row">
          <button type="submit" className="primary">
            {t('save')}
          </button>
          {saved && (
            <button
              type="button"
              onClick={() => {
                setUrls('')
                setUsername('')
                setCredential('')
                apply(null)
              }}
            >
              {t('remove')}
            </button>
          )}
        </div>
      </form>
    </section>
  )
}
