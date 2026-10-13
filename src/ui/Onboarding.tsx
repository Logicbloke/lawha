import { useState } from 'react'
import { commitIdentity, importAndCommit, prepareIdentity, unlock, useApp, type Phase } from '../state/store'
import { translateError, useT, type TKey } from './i18n'
import { LangPicker } from './LangPicker'
import { QrScanner, qrScanSupported } from './QrScanner'
import { SESSION_DURATIONS, sessionsSupported } from '../core/session'
import type { Identity } from '../core/types'

/** "Stay signed in for …" picker; value is a duration in ms, 0 = off. */
function RememberSelect({ value, onChange }: { value: number; onChange: (ms: number) => void }) {
  const t = useT()
  if (!sessionsSupported()) return null
  return (
    <>
      <label className="field">
        <span>{t('sessionStayLabel')}</span>
        <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
          <option value={0}>{t('sessionOff')}</option>
          {SESSION_DURATIONS.map((d) => (
            <option key={d.id} value={d.ms}>
              {t(`session${d.id}` as TKey)}
            </option>
          ))}
        </select>
      </label>
      {value > 0 && <p className="hint">{t('sessionWarn')}</p>}
    </>
  )
}

type Step =
  | { name: 'choose' }
  | { name: 'backup'; identity: Identity; backup: string }
  | { name: 'passphrase'; identity: Identity }
  | { name: 'import' }

function Shell({ children }: { children: React.ReactNode }) {
  const t = useT()
  return (
    <div className="onboarding">
      <div className="onboarding-top">
        <span className="wordmark">
          {t('brand')}
          <span className="wordmark-ar" lang="ar">
            لوحة
          </span>
        </span>
        <LangPicker />
      </div>
      <div className="onboarding-body">{children}</div>
    </div>
  )
}

export function Onboarding({ phase }: { phase: Phase }) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const [step, setStep] = useState<Step>({ name: 'choose' })
  const [passphrase, setPassphrase] = useState('')
  const [backupInput, setBackupInput] = useState('')
  const [remember, setRemember] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)

  const fail = (err: Error) => setError(translateError(lang, err.message))

  if (phase === 'loading') return <div className="onboarding loading">{t('obLoading')}</div>

  if (phase === 'other-tab') {
    return (
      <Shell>
        <h1>{t('otherTabTitle')}</h1>
        <p>{t('otherTabBody')}</p>
        <button className="primary" onClick={() => location.reload()}>
          {t('otherTabRetry')}
        </button>
      </Shell>
    )
  }

  if (phase === 'locked') {
    return (
      <Shell>
        <h1>{t('obLockedTitle')}</h1>
        <p>{t('obLockedMsg')}</p>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault()
            setBusy(true)
            setError(null)
            unlock(passphrase, remember)
              .catch(fail)
              .finally(() => setBusy(false))
          }}
        >
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder={t('obPassphrase')}
            aria-label={t('obPassphrase')}
            autoFocus
          />
          <RememberSelect value={remember} onChange={setRemember} />
          <button className="primary" disabled={busy || !passphrase}>
            {busy ? t('obUnlocking') : t('obUnlock')}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </Shell>
    )
  }

  if (step.name === 'choose') {
    return (
      <Shell>
        <h1>{t('obHeadline')}</h1>
        <p className="lede">{t('obIntro')}</p>
        <div className="stack">
          <button className="primary" onClick={() => setStep({ name: 'backup', ...prepareIdentity() })}>
            {t('obCreate')}
          </button>
          <button onClick={() => setStep({ name: 'import' })}>{t('obImportExisting')}</button>
        </div>
      </Shell>
    )
  }

  if (step.name === 'backup') {
    return (
      <Shell>
        <h2>{t('obBackupTitle')}</h2>
        <p>{t('obBackupWarn')}</p>
        <code className="backup" dir="ltr">
          {step.backup}
        </code>
        <button className="primary" onClick={() => setStep({ name: 'passphrase', identity: step.identity })}>
          {t('obSavedContinue')}
        </button>
      </Shell>
    )
  }

  if (step.name === 'passphrase') {
    return (
      <Shell>
        <h2>{t('obEncryptTitle')}</h2>
        <p>{t('obEncryptWarn')}</p>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault()
            setBusy(true)
            commitIdentity(step.identity, passphrase || undefined, remember)
              .catch(fail)
              .finally(() => setBusy(false))
          }}
        >
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder={t('obPassOptionalPlaceholder')}
            aria-label={t('obPassOptionalPlaceholder')}
            autoFocus
          />
          {passphrase && <RememberSelect value={remember} onChange={setRemember} />}
          <button className="primary" disabled={busy}>
            {busy ? t('obSettingUp') : passphrase ? t('obEncryptStart') : t('obSkipStart')}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </Shell>
    )
  }

  return (
    <Shell>
      <h2>{t('obImportTitle')}</h2>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          importAndCommit(backupInput, passphrase || undefined, remember)
            .catch(fail)
            .finally(() => setBusy(false))
        }}
      >
        <textarea
          value={backupInput}
          onChange={(e) => setBackupInput(e.target.value)}
          placeholder="lawha-key-v1:…"
          aria-label={t('obImportTitle')}
          dir="ltr"
          autoFocus
        />
        <p className="hint">{t('obImportHint')}</p>
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder={t('obImportPassPlaceholder')}
          aria-label={t('obImportPassPlaceholder')}
        />
        {passphrase && <RememberSelect value={remember} onChange={setRemember} />}
        <button className="primary" disabled={busy || !backupInput.trim()}>
          {busy ? t('obImporting') : t('obImport')}
        </button>
      </form>
      {qrScanSupported() && (
        <button className="link" onClick={() => setScanning(true)}>
          {t('qrScan')}
        </button>
      )}
      {error && <p className="error">{error}</p>}
      <button className="link" onClick={() => setStep({ name: 'choose' })}>
        {t('obBack')}
      </button>
      {scanning && (
        <QrScanner
          onResult={(text) => {
            setScanning(false)
            setBackupInput(text)
          }}
          onClose={() => setScanning(false)}
        />
      )}
    </Shell>
  )
}
