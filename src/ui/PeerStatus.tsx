import { useApp } from '../state/store'
import { useT } from './i18n'

/** One dot per discovery network, then how many peers we are talking to. */
export function PeerStatus() {
  const peers = useApp((s) => s.peers)
  const t = useT()
  const entries = Object.entries(peers)
  if (entries.length === 0) return <span className="peer-status">{t('peersOffline')}</span>
  const total = entries.reduce((n, [, v]) => n + v.peerCount, 0)
  return (
    <span className="peer-status" title={entries.map(([k, v]) => `${k}: ${v.state} (${v.peerCount})`).join('\n')}>
      <span className="dots" aria-hidden="true">
        {entries.map(([k, v]) => (
          <span key={k} className={`dot ${v.state}`} />
        ))}
      </span>
      {total === 0 ? t('peersNone') : t('peersN', { n: total })}
    </span>
  )
}
