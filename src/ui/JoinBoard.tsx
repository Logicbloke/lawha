import { useState } from 'react'
import { joinInvite, parseInvite } from '../state/actions'
import { QrScanner, qrScanSupported } from './QrScanner'
import { useT } from './i18n'

/**
 * Join a board or company from an invite. Links open here directly; the
 * paste field matters on iPhone, where a tapped link opens Safari rather than
 * the installed app (they keep separate storage, so the key is not there).
 */
export function JoinBoard({ code }: { code: string }) {
  const t = useT()
  const [input, setInput] = useState(code ? `#/join/${code}` : '')
  const [scanning, setScanning] = useState(false)
  const invite = parseInvite(input)
  return (
    <div className="join">
      <h1>{t('joinTitle')}</h1>
      <p className="lede">{t('joinLede')}</p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          if (invite) void joinInvite(invite)
        }}
      >
        <input
          value={input}
          dir="ltr"
          autoFocus={!code}
          placeholder={t('pasteInvite')}
          aria-label={t('pasteInvite')}
          onChange={(e) => setInput(e.target.value)}
        />
        {input && !invite && <p className="error">{t('notAnInvite')}</p>}
        {invite && <p className="hint">{invite.ws === invite.board ? t('joiningCompany') : invite.ws ? t('joiningCompanyBoard') : t('joiningBoard')}</p>}
        <button className="primary" disabled={!invite}>
          {t('join')}
        </button>
      </form>
      {qrScanSupported() && (
        <button className="link" onClick={() => setScanning(true)}>
          {t('qrScanInvite')}
        </button>
      )}
      {scanning && (
        <QrScanner
          onResult={(text) => {
            setScanning(false)
            setInput(text)
          }}
          onClose={() => setScanning(false)}
        />
      )}
    </div>
  )
}
