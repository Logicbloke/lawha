import type { BoardView } from '../core/board'
import { askPermission, setNotifyPrefs, useNotify, useNotifyPrefs, type NotifyPrefs } from '../state/notify'
import { useT, type TKey } from './i18n'

/** What this device tells you about on this board; kept here, never sent. */
export function NotifySettings({ view, onDone }: { view: BoardView; onDone(): void }) {
  const t = useT()
  const permission = useNotify((s) => s.permission)
  const prefs = useNotifyPrefs(view.id)
  const set = (patch: Partial<NotifyPrefs>) => setNotifyPrefs(view.id, patch)
  const toggle = (key: 'all' | 'assigned' | 'involved' | 'mentions', label: TKey) => (
    <label className="check-row">
      <input type="checkbox" checked={prefs[key]} onChange={(e) => set({ [key]: e.target.checked })} />
      <span>{t(label)}</span>
    </label>
  )

  return (
    <div className="stack notify-settings">
      <h2>{t('notifications')}</h2>
      {permission === 'unsupported' && <p className="notice warn">{t('notifyUnsupported')}</p>}
      {permission === 'denied' && <p className="notice warn">{t('notifyDenied')}</p>}
      {permission === 'default' && (
        <div className="notice">
          <p>{t('notifyAsk')}</p>
          <button className="primary" onClick={() => void askPermission()}>
            {t('notifyAllow')}
          </button>
        </div>
      )}

      <fieldset>
        <legend>{t('notifyAbout')}</legend>
        {toggle('mentions', 'notifyMentions')}
        {toggle('assigned', 'notifyAssigned')}
        {toggle('involved', 'notifyInvolved')}
        {toggle('all', 'notifyAll')}
      </fieldset>

      {view.columns.length > 0 && (
        <fieldset disabled={prefs.all}>
          <legend>{t('notifyColumns')}</legend>
          {view.columns.map((c) => (
            <label key={c.id} className="check-row">
              <input
                type="checkbox"
                checked={prefs.all || prefs.columns.includes(c.id)}
                onChange={(e) =>
                  set({ columns: e.target.checked ? [...prefs.columns, c.id] : prefs.columns.filter((x) => x !== c.id) })
                }
              />
              <span>{c.name}</span>
            </label>
          ))}
        </fieldset>
      )}

      <p className="hint">{t('notifyLocal')}</p>
      <p className="hint">{t('secN6')}</p>
      <div className="row">
        <button onClick={onDone}>{t('done')}</button>
      </div>
    </div>
  )
}
