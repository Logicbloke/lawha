import { useState } from 'react'
import type { BoardView } from '../core/board'
import { RANK } from '../core/types'
import { getEngine } from '../state/store'
import { moveCards, moveCardsToBoard } from '../state/actions'
import { Modal } from './CardDetail'
import { useT } from './i18n'

/**
 * Move one card or a whole selection to a column on this board or another
 * board of the same workspace (where you can edit). Moving to another board
 * copies the cards there and leaves read-only stubs behind.
 */
export function MoveDialog({ view, ids, onClose }: { view: BoardView; ids: string[]; onClose(done: boolean): void }) {
  const t = useT()
  const engine = getEngine()
  const ws = engine.wsOf(view.id)
  const targets = engine
    .records()
    .filter((r) => !r.hidden && r.kind === 'board' && engine.wsOf(r.id) === ws)
    .map((r) => engine.view(r.id))
    .filter((v): v is BoardView => !!v && RANK[v.myRole] >= RANK.editor && v.columns.length > 0)
  const [board, setBoard] = useState(view.id)
  const target = targets.find((v) => v.id === board) ?? view
  const [col, setCol] = useState(target.columns[0]?.id ?? '')
  const colId = target.columns.some((c) => c.id === col) ? col : (target.columns[0]?.id ?? '')
  const [busy, setBusy] = useState(false)

  return (
    <Modal label={t('moveNCards', { n: ids.length })} onClose={() => onClose(false)}>
      <form
        className="move-dialog stack"
        onSubmit={(e) => {
          e.preventDefault()
          if (!colId) return
          setBusy(true)
          const done =
            board === view.id
              ? moveCards(view.id, ids, colId, (view.byColumn.get(colId) ?? []).length)
              : moveCardsToBoard(view.id, board, ids, colId)
          void done.finally(() => onClose(true))
        }}
      >
        <h2>{t('moveNCards', { n: ids.length })}</h2>
        <label className="field">
          <span>{t('board')}</span>
          <select value={board} onChange={(e) => setBoard(e.target.value)}>
            {targets.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name || t('untitledBoard')}
                {v.id === view.id ? ` (${t('thisBoard')})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('column')}</span>
          <select value={colId} onChange={(e) => setCol(e.target.value)}>
            {target.columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {board !== view.id && <p className="hint">{t('moveOtherBoardHint')}</p>}
        <div className="row">
          <button className="primary" disabled={busy || !colId}>
            {t('move')}
          </button>
          <button type="button" className="link" onClick={() => onClose(false)}>
            {t('cancel')}
          </button>
        </div>
      </form>
    </Modal>
  )
}
