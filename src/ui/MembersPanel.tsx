import { useEffect, useState } from 'react'
import { RANK, type Role } from '../core/types'
import { getEngine, me, navigate, shareableBase, useApp } from '../state/store'
import {
  addMember,
  inviteCode,
  inviteLink,
  isPubKey,
  leaveBoard,
  listContacts,
  removeFromCompany,
  removeMember,
  setMemberRole,
} from '../state/actions'
import type { ContactRecord } from '../core/types'
import { copyText, formatRelative, shortKey, useBoard, useNow } from './hooks'
import { Identicon } from './Identicon'
import { QrCode } from './QrCode'
import { QrScanner, qrScanSupported } from './QrScanner'
import { useT, type TKey } from './i18n'

const ASSIGNABLE: Array<Exclude<Role, 'owner'>> = ['viewer', 'editor', 'admin']
const NONE: string[] = []

function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useT()
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={() =>
        void copyText(text).then((ok) => {
          setDone(ok)
          setTimeout(() => setDone(false), 2000)
        })
      }
    >
      {done ? t('copied') : label}
    </button>
  )
}

export function MembersPanel({ id }: { id: string }) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const waiting = useApp((s) => s.waiting[id]) ?? NONE
  const now = useNow()
  const v = useBoard(id)
  const engine = getEngine()
  const [key, setKey] = useState('')
  const [role, setRole] = useState<Exclude<Role, 'owner'>>('editor')
  const [contacts, setContacts] = useState<ContactRecord[]>([])
  const [scanning, setScanning] = useState(false)
  const [showQr, setShowQr] = useState(false)

  useEffect(() => {
    void listContacts().then(setContacts)
  }, [])

  if (!v || v.owner === null) {
    return (
      <div className="members">
        <p className="lede">{t('waitingBody')}</p>
      </div>
    )
  }

  const isWs = v.kind === 'workspace'
  const myRank = RANK[v.myRole]
  const canManage = myRank >= RANK.admin
  const ws = engine.wsOf(id)
  const roster = ws && ws !== id ? engine.view(ws) : null
  const memberSet = new Set(v.members.map((m) => m.pub))
  const contactName = new Map(contacts.map((c) => [c.pub, c.name]))
  const candidates = (roster ? roster.members.map((m) => ({ pub: m.pub, name: m.name || contactName.get(m.pub) || '' })) : contacts)
    .filter((c) => !memberSet.has(c.pub))
  const base = shareableBase()
  const code = inviteCode(id, isWs ? id : ws)
  const link = base ? inviteLink(base, id, isWs ? id : ws) : null
  const keyOk = isPubKey(key)
  const offRoster = roster && keyOk && !roster.members.some((m) => m.pub === key.trim())

  return (
    <div className="members">
      <header className="members-head">
        <h1>{isWs ? t('coworkersTitle', { name: v.name || t('unnamedWorkspace') }) : t('membersOf', { name: v.name || t('untitledBoard') })}</h1>
        {!isWs && (
          <button className="link" onClick={() => navigate({ name: 'board', id })}>
            {t('backToBoard')}
          </button>
        )}
      </header>
      <p className="lede">{isWs ? t('workspaceLede') : roster ? t('companyBoardLede', { name: roster.name }) : t('boardMembersLede')}</p>
      {v.needsHeal && <p className="notice">{t('keyRotationPending')}</p>}

      {canManage && (
        <section className="panel">
          <h2>{isWs ? t('addCoworker') : t('addMember')}</h2>
          <form
            className="add-member"
            onSubmit={(e) => {
              e.preventDefault()
              if (!keyOk) return
              void addMember(id, key.trim(), role)
              setKey('')
            }}
          >
            <input
              value={key}
              dir="ltr"
              placeholder={t('pastePublicKey')}
              aria-label={t('pastePublicKey')}
              aria-invalid={key.length > 0 && !keyOk}
              onChange={(e) => setKey(e.target.value)}
            />
            <select value={role} aria-label={t('role')} onChange={(e) => setRole(e.target.value as Exclude<Role, 'owner'>)}>
              {ASSIGNABLE.filter((r) => RANK[r] < myRank).map((r) => (
                <option key={r} value={r}>
                  {t(`role_${r}` as TKey)}
                </option>
              ))}
            </select>
            <button className="primary" disabled={!keyOk}>
              {t('add')}
            </button>
          </form>
          {key.length > 0 && !keyOk && <p className="error">{t('notAKey')}</p>}
          {offRoster && <p className="notice warn">{t('notOnRoster')}</p>}
          <div className="row">
            {qrScanSupported() && (
              <button className="link" onClick={() => setScanning(true)}>
                {t('qrScanKey')}
              </button>
            )}
          </div>
          {candidates.length > 0 && (
            <>
              <h3>{roster ? t('fromCompany') : t('fromContacts')}</h3>
              <ul className="candidates">
                {candidates.map((c) => (
                  <li key={c.pub}>
                    <button onClick={() => setKey(c.pub)}>
                      <Identicon pub={c.pub} size={20} />
                      <span>{c.name || shortKey(c.pub)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {waiting.filter((p) => !memberSet.has(p)).length > 0 && (
            <>
              <h3>{t('askingToJoin')}</h3>
              <ul className="candidates">
                {waiting
                  .filter((p) => !memberSet.has(p))
                  .map((p) => (
                    <li key={p}>
                      <button onClick={() => setKey(p)}>
                        <Identicon pub={p} size={20} />
                        <code dir="ltr">{shortKey(p)}</code>
                      </button>
                    </li>
                  ))}
              </ul>
            </>
          )}
          <h3>{t('inviteLink')}</h3>
          <p className="hint">{t('inviteHint')}</p>
          <div className="invite">
            <code dir="ltr">{link ?? code}</code>
            <CopyButton text={link ?? code} label={t('copy')} />
            <button className="link" onClick={() => setShowQr(!showQr)}>
              {showQr ? t('hideQr') : t('showQr')}
            </button>
          </div>
          {showQr && <QrCode value={code} />}
        </section>
      )}

      <section className="panel">
        <h2>{t('nMembers', { n: v.members.length })}</h2>
        <ul className="member-list">
          {v.members.map((m) => {
            const mine = m.pub === me().pub
            const canChange = canManage && !mine && myRank > RANK[m.role]
            const lastSeen = Math.max(0, ...m.devices.map((d) => d.lastTs))
            return (
              <li key={m.pub}>
                <Identicon pub={m.pub} size={32} />
                <div className="member-who">
                  <span className="member-name">
                    {m.name || contactName.get(m.pub) || t('noName')}
                    {mine && <span className="you">{t('you')}</span>}
                  </span>
                  <code dir="ltr" title={m.pub}>
                    {shortKey(m.pub)}
                  </code>
                  <span className="member-devices">
                    {m.devices.length === 0
                      ? t('neverSeen')
                      : t('devicesSeen', { n: m.devices.length, when: formatRelative(lastSeen, now, lang) })}
                  </span>
                </div>
                {canChange ? (
                  <select
                    value={m.role}
                    aria-label={t('roleOf', { name: m.name || shortKey(m.pub) })}
                    onChange={(e) => void setMemberRole(id, m.pub, e.target.value as Exclude<Role, 'owner'>)}
                  >
                    {ASSIGNABLE.filter((r) => RANK[r] < myRank).map((r) => (
                      <option key={r} value={r}>
                        {t(`role_${r}` as TKey)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className={`role role-${m.role}`}>{t(`role_${m.role}` as TKey)}</span>
                )}
                {canChange && (
                  <button
                    className="danger"
                    onClick={() => {
                      if (!confirm(isWs ? t('removeCoworkerConfirm') : t('removeConfirm'))) return
                      void (isWs ? removeFromCompany(id, m.pub) : removeMember(id, m.pub))
                    }}
                  >
                    {t('remove')}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      {v.myRole !== 'owner' && (
        <button
          className="danger"
          onClick={() => {
            if (confirm(t('leaveConfirm'))) void leaveBoard(id)
          }}
        >
          {isWs ? t('leaveCompany') : t('leaveBoard')}
        </button>
      )}
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
