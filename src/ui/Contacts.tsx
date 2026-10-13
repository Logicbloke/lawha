import { useEffect, useState } from 'react'
import type { ContactRecord } from '../core/types'
import { forgetContact, isPubKey, listContacts, saveContact } from '../state/actions'
import { me } from '../state/store'
import { copyText, shortKey } from './hooks'
import { Identicon } from './Identicon'
import { QrCode } from './QrCode'
import { QrScanner, qrScanSupported } from './QrScanner'
import { useT } from './i18n'

/** Your key to share, and an address book of other people's keys. */
export function Contacts() {
  const t = useT()
  const pub = me().pub
  const [list, setList] = useState<ContactRecord[]>([])
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [scanning, setScanning] = useState(false)
  const [copied, setCopied] = useState(false)
  const reload = () => void listContacts().then((l) => setList(l.sort((a, b) => a.name.localeCompare(b.name))))
  useEffect(reload, [])

  return (
    <div className="contacts">
      <h1>{t('navContacts')}</h1>
      <section className="panel my-key">
        <h2>{t('myKey')}</h2>
        <p className="hint">{t('myKeyHint')}</p>
        <div className="key-card">
          <Identicon pub={pub} size={40} />
          <code dir="ltr" className="pubkey">
            {pub}
          </code>
          <button
            onClick={() =>
              void copyText(pub).then((ok) => {
                setCopied(ok)
                setTimeout(() => setCopied(false), 2000)
              })
            }
          >
            {copied ? t('copied') : t('copyMyKey')}
          </button>
          <QrCode value={pub} size={168} />
        </div>
      </section>

      <section className="panel">
        <h2>{t('addContact')}</h2>
        <form
          className="add-contact"
          onSubmit={(e) => {
            e.preventDefault()
            if (!isPubKey(key) || !name.trim()) return
            void saveContact(key, name).then(reload)
            setKey('')
            setName('')
          }}
        >
          <input value={name} maxLength={80} placeholder={t('displayName')} aria-label={t('displayName')} onChange={(e) => setName(e.target.value)} />
          <input value={key} dir="ltr" placeholder={t('pastePublicKey')} aria-label={t('pastePublicKey')} onChange={(e) => setKey(e.target.value)} />
          <button className="primary" disabled={!isPubKey(key) || !name.trim()}>
            {t('save')}
          </button>
        </form>
        {key.length > 0 && !isPubKey(key) && <p className="error">{t('notAKey')}</p>}
        {qrScanSupported() && (
          <button className="link" onClick={() => setScanning(true)}>
            {t('qrScanKey')}
          </button>
        )}
        <ul className="member-list">
          {list.map((c) => (
            <li key={c.pub}>
              <Identicon pub={c.pub} size={32} />
              <div className="member-who">
                <span className="member-name">{c.name}</span>
                <code dir="ltr" title={c.pub}>
                  {shortKey(c.pub)}
                </code>
              </div>
              <button className="link" onClick={() => void forgetContact(c.pub).then(reload)}>
                {t('remove')}
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="muted">{t('noContacts')}</li>}
        </ul>
      </section>
      {scanning && (
        <QrScanner
          onResult={(text) => {
            setScanning(false)
            setKey(text.trim())
          }}
          onClose={() => setScanning(false)}
        />
      )}
    </div>
  )
}
