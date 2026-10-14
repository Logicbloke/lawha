import { useApp } from '../state/store'
import { useNow } from './hooks'
import { useT } from './i18n'

/** a failed direct connection keeps the warning up this long */
const BLOCKED_MS = 10 * 60_000
const NAMES: Record<string, string> = { nostr: 'Nostr', mqtt: 'MQTT', torrent: 'BitTorrent' }

/** One dot per discovery network and how many peers we are connected to; opens on the details. */
export function PeerStatus() {
  const t = useT()
  const net = useApp((s) => s.net)
  const now = useNow()
  const online = navigator.onLine !== false
  const relays = Object.entries(net.relays)
  const blocked = net.unreachableAt > 0 && now - net.unreachableAt < BLOCKED_MS
  return (
    <details className="menu peer-status">
      <summary>
        {relays.length > 0 && (
          <span className="net-dots" aria-hidden="true">
            {relays.map(([k, h]) => (
              <span key={k} className={`net-dot ${h.open > 0 ? 'ok' : h.total > 0 ? 'wait' : 'off'}`} />
            ))}
          </span>
        )}
        {!online ? t('peersOffline') : net.peers > 0 ? t('peersN', { n: net.peers }) : t('peersNone')}
        {blocked && (
          <svg className="net-warn" viewBox="0 0 16 16" width="14" height="14" role="img" aria-label={t('netBlockedShort')}>
            <path d="M8 1.5 15 14H1z" fill="currentColor" />
            <path d="M8 6v3.6M8 11.4v.1" stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        )}
      </summary>
      <div className="menu-pop up net-pop">
        <h3>{t('netTitle')}</h3>
        <p>{net.peers > 0 ? t('netPeers', { n: net.peers }) : t('netAlone')}</p>
        {blocked && <p className="net-blocked">{t('netBlocked')}</p>}
        {relays.length > 0 && <p className="net-caption">{t('netRelays')}</p>}
        {relays.length > 0 && (
          <ul className="net-relays">
            {relays.map(([k, h]) => (
              <li key={k}>
                <span className={`net-dot ${h.open > 0 ? 'ok' : h.total > 0 ? 'wait' : 'off'}`} aria-hidden="true" />
                <bdi className="net-name">{NAMES[k] ?? k}</bdi>
                <bdi dir="ltr">
                  {h.open}/{h.total}
                </bdi>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  )
}
