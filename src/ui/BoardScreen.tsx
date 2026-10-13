import { useMemo, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, horizontalListSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { RANK } from '../core/types'
import type { BoardView } from '../core/board'
import { getEngine, me, navigate, useApp } from '../state/store'
import { addColumn, archiveCards, moveCards, moveColumn, renameBoard } from '../state/actions'
import { useBoard, useNow, copyText } from './hooks'
import { useT } from './i18n'
import { Column } from './Column'
import { CardFace, CardItem } from './CardItem'
import { CardDetail } from './CardDetail'
import { MoveDialog } from './MoveDialog'
import { BoardMenu } from './BoardMenu'
import { Identicon } from './Identicon'
import { QrCode } from './QrCode'

export function BoardScreen({ id }: { id: string }) {
  const v = useBoard(id)
  if (!v || v.owner === null || v.myRole === 'none') return <NoAccess id={id} view={v} />
  return <Board view={v} />
}

/** Not synced yet, or not (or no longer) a member: show what to do about it. */
function NoAccess({ id, view }: { id: string; view: BoardView | null }) {
  const t = useT()
  useNow() // re-check peer status periodically
  const pub = me().pub
  const engine = getEngine()
  const peers = engine.sync.peersOf(id)
  const removed = !!view && view.owner !== null && view.myRole === 'none'
  const noRoom = engine.roomSpec(id) === null
  const [copied, setCopied] = useState(false)
  return (
    <div className="no-access">
      <h1>{removed ? t('notMemberTitle') : t('waitingTitle')}</h1>
      <p className="lede">
        {noRoom ? t('waitingCompany') : removed ? t('notMemberBody') : peers.length > 0 ? t('waitingConnected', { n: peers.length }) : t('waitingBody')}
      </p>
      <div className="key-card">
        <Identicon pub={pub} size={40} />
        <code dir="ltr">{pub}</code>
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
      <button className="link" onClick={() => void getEngine().setHidden(id, true).then(() => navigate({ name: 'home' }))}>
        {t('forgetBoard')}
      </button>
    </div>
  )
}

type Drag = { type: 'card'; id: string; ids: string[] } | { type: 'column'; id: string } | null

/**
 * Keyboard dragging: up/down reorders within a column (dnd-kit's sortable
 * getter); left/right jumps a card to the neighbouring column's drop zone.
 * Purely geometric, so "right" is visually right in Arabic too.
 */
const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  const { active, collisionRect, droppableRects, droppableContainers } = args.context
  const horizontal = event.code === 'ArrowRight' || event.code === 'ArrowLeft'
  if (!horizontal || active?.data.current?.type !== 'card' || !collisionRect) {
    return sortableKeyboardCoordinates(event, args)
  }
  const cx = collisionRect.left + collisionRect.width / 2
  const right = event.code === 'ArrowRight'
  const zones = droppableContainers
    .getEnabled()
    .filter((c) => String(c.id).startsWith('drop:'))
    .map((c) => droppableRects.get(c.id))
    .filter((r) => r !== undefined)
    .filter((r) => (right ? r.left > cx : r.right < cx))
    .sort((a, b) => (right ? a.left - b.left : b.right - a.right))
  const target = zones[0]
  if (!target) return undefined
  event.preventDefault()
  return { x: target.left + 4, y: target.top + 4 }
}

/** Clicks that land right after a drag (Space/Enter keyup, mouse up) are not "open". */
let lastDragAt = 0
export function justDragged(): boolean {
  return Date.now() - lastDragAt < 350
}

function Board({ view }: { view: BoardView }) {
  const t = useT()
  const lang = useApp((s) => s.lang)
  const selection = useApp((s) => s.selection)
  const canEdit = RANK[view.myRole] >= RANK.editor
  const isAdmin = RANK[view.myRole] >= RANK.admin
  const dir = lang === 'ar' ? 'rtl' : 'ltr'

  const [openCard, setOpenCard] = useState<string | null>(null)
  const [moving, setMoving] = useState<string[] | null>(null)
  const [drag, setDrag] = useState<Drag>(null)
  const [layout, setLayout] = useState<Map<string, string[]> | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [name, setName] = useState(view.name)
  const [newCol, setNewCol] = useState('')

  const base = useMemo(
    () => new Map(view.columns.map((c) => [c.id, (view.byColumn.get(c.id) ?? []).map((x) => x.id)])),
    [view],
  )
  const current = layout ?? base
  const allCardIds = useMemo(() => new Set(view.cards.keys()), [view])
  const order = useMemo(() => [...base.values()].flat().concat(view.unsorted.map((c) => c.id)), [base, view])

  const setSelection = (ids: string[]) => useApp.setState({ selection: ids })
  const toggle = (id: string, range: boolean) => {
    if (range && selection.length > 0) {
      const a = order.indexOf(selection[selection.length - 1]!)
      const b = order.indexOf(id)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      setSelection([...new Set([...selection, ...order.slice(lo, hi + 1)])])
      return
    }
    setSelection(selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id])
  }

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }),
  )

  /** Cards prefer the card under the pointer, then the column body; columns only see columns. */
  const collision: CollisionDetection = (args) => {
    const type = args.active.data.current?.type
    const containers = args.droppableContainers.filter((c) =>
      type === 'column' ? c.data.current?.type === 'column' : c.data.current?.type !== 'column',
    )
    const scoped = { ...args, droppableContainers: containers }
    if (type === 'card') {
      const hits = pointerWithin(scoped)
      const card = hits.find((h) => allCardIds.has(String(h.id)))
      if (card) return [card]
      if (hits.length > 0) return hits
    }
    return closestCorners(scoped)
  }

  const colOf = (id: string, l: Map<string, string[]>): string | null => {
    if (id.startsWith('drop:')) return id.slice(5)
    if (id.startsWith('col:')) return id.slice(4)
    for (const [col, ids] of l) if (ids.includes(id)) return col
    return null
  }

  const onDragStart = (e: DragStartEvent) => {
    lastDragAt = Date.now()
    const id = String(e.active.id)
    if (id.startsWith('col:')) {
      setDrag({ type: 'column', id: id.slice(4) })
      return
    }
    const ids = selection.includes(id) ? order.filter((x) => selection.includes(x)) : [id]
    // the rest of a dragged group leaves its columns while in the air
    const others = new Set(ids.filter((x) => x !== id))
    const l = new Map([...base].map(([c, list]) => [c, list.filter((x) => !others.has(x))]))
    setLayout(l)
    setDrag({ type: 'card', id, ids })
  }

  const onDragOver = (e: DragOverEvent) => {
    if (drag?.type !== 'card' || !e.over || !layout) return
    const activeId = String(e.active.id)
    const from = colOf(activeId, layout)
    const to = colOf(String(e.over.id), layout)
    if (!to || from === to) return
    const target = layout.get(to) ?? []
    const overIdx = target.indexOf(String(e.over.id))
    const next = new Map(layout)
    if (from) next.set(from, (next.get(from) ?? []).filter((x) => x !== activeId))
    const list = [...target]
    list.splice(overIdx >= 0 ? overIdx : list.length, 0, activeId)
    next.set(to, list)
    setLayout(next)
  }

  const onDragEnd = (e: DragEndEvent) => {
    lastDragAt = Date.now()
    const d = drag
    const l = layout
    setDrag(null)
    setLayout(null)
    if (!d || !e.over) return
    if (d.type === 'column') {
      const overId = String(e.over.id)
      if (!overId.startsWith('col:')) return
      const from = view.columns.findIndex((c) => c.id === d.id)
      const to = view.columns.findIndex((c) => c.id === overId.slice(4))
      if (from >= 0 && to >= 0 && from !== to) void moveColumn(view.id, d.id, to)
      return
    }
    if (!l) return
    const col = colOf(d.id, l)
    if (!col) return
    let list = l.get(col) ?? []
    const overId = String(e.over.id)
    const oldIdx = list.indexOf(d.id)
    const overIdx = list.indexOf(overId)
    if (overIdx >= 0 && oldIdx >= 0 && overIdx !== oldIdx) list = arrayMove(list, oldIdx, overIdx)
    const moving = new Set(d.ids)
    const index = list.slice(0, list.indexOf(d.id)).filter((x) => !moving.has(x)).length
    // a single card dropped back where it was: nothing to write
    if (d.ids.length === 1 && (base.get(col) ?? []).indexOf(d.id) === index) return
    void moveCards(view.id, d.ids, col, index)
    if (d.ids.length > 1) setSelection([])
  }

  const nameOf = (id: string) => {
    if (id.startsWith('col:')) return view.columns.find((c) => c.id === id.slice(4))?.name ?? ''
    if (id.startsWith('drop:')) return view.columns.find((c) => c.id === id.slice(5))?.name ?? ''
    return view.cards.get(id)?.title ?? ''
  }
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('dndPicked', { name: nameOf(String(active.id)) }),
    onDragOver: ({ active, over }) =>
      over ? t('dndOver', { name: nameOf(String(active.id)), target: nameOf(String(over.id)) }) : t('dndNotOver', { name: nameOf(String(active.id)) }),
    onDragEnd: ({ active, over }) =>
      over ? t('dndDropped', { name: nameOf(String(active.id)), target: nameOf(String(over.id)) }) : t('dndCancelled', { name: nameOf(String(active.id)) }),
    onDragCancel: ({ active }) => t('dndCancelled', { name: nameOf(String(active.id)) }),
  }

  const hidden = new Set(drag?.type === 'card' ? drag.ids.filter((x) => x !== drag.id) : [])
  const dragCard = drag?.type === 'card' ? view.cards.get(drag.id) : undefined
  const dragCol = drag?.type === 'column' ? view.columns.find((c) => c.id === drag.id) : undefined
  const cardsFor = (colId: string) =>
    (current.get(colId) ?? []).map((id) => view.cards.get(id)).filter((c) => c !== undefined)

  return (
    <div className="board">
      <header className="board-head">
        {editingName ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim() && name.trim() !== view.name) void renameBoard(view.id, name.trim())
              setEditingName(false)
            }}
          >
            <input
              className="board-name-input"
              autoFocus
              value={name}
              maxLength={80}
              aria-label={t('boardName')}
              onChange={(e) => setName(e.target.value)}
              onBlur={(e) => e.currentTarget.form?.requestSubmit()}
            />
          </form>
        ) : (
          <h1 className="board-name" dir="auto" onDoubleClick={() => isAdmin && (setName(view.name), setEditingName(true))}>
            {view.name || t('untitledBoard')}
          </h1>
        )}
        <div className="board-actions">
          <button className="members-btn" onClick={() => navigate({ name: 'members', id: view.id })} aria-label={t('members')}>
            <span className="avatars" aria-hidden="true">
              {view.members.slice(0, 4).map((m) => (
                <Identicon key={m.pub} pub={m.pub} size={22} />
              ))}
            </span>
            <span>{t('nMembers', { n: view.members.length })}</span>
          </button>
          <BoardMenu view={view} onRename={() => (setName(view.name), setEditingName(true))} />
        </div>
      </header>
      {view.stats.forkedDevices > 0 && <p className="notice warn">{t('forkWarning')}</p>}
      {!canEdit && <p className="notice">{t('viewerNotice')}</p>}

      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => ((lastDragAt = Date.now()), setDrag(null), setLayout(null))}
        accessibility={{ announcements, screenReaderInstructions: { draggable: t('dndInstructions') } }}
      >
        <div className={`board-scroll ${dir}`} dir="ltr">
          {view.unsorted.length > 0 && (
            <section className="column unsorted" dir={dir} aria-label={t('unsorted')}>
              <header className="column-head">
                <h2 className="column-name">{t('unsorted')}</h2>
                <span className="column-count">{view.unsorted.length}</span>
              </header>
              <SortableContext items={view.unsorted.map((c) => c.id)}>
                <ul className="cards">
                  {view.unsorted.map((c) => (
                    <CardItem
                      key={c.id}
                      card={c}
                      view={view}
                      selected={selection.includes(c.id)}
                      selecting={selection.length > 0}
                      disabled={!canEdit}
                      onOpen={setOpenCard}
                      onToggle={toggle}
                    />
                  ))}
                </ul>
              </SortableContext>
            </section>
          )}
          <SortableContext items={view.columns.map((c) => `col:${c.id}`)} strategy={horizontalListSortingStrategy}>
            {view.columns.map((c) => (
              <Column
                key={c.id}
                view={view}
                column={c}
                cards={cardsFor(c.id)}
                canEdit={canEdit}
                selection={selection}
                hidden={hidden}
                onOpen={setOpenCard}
                onToggle={toggle}
                dir={dir}
              />
            ))}
          </SortableContext>
          {canEdit && (
            <form
              className="column add-column"
              dir={dir}
              onSubmit={(e) => {
                e.preventDefault()
                if (newCol.trim()) void addColumn(view.id, newCol.trim())
                setNewCol('')
              }}
            >
              <input
                value={newCol}
                maxLength={80}
                placeholder={t('addColumn')}
                aria-label={t('addColumn')}
                onChange={(e) => setNewCol(e.target.value)}
              />
            </form>
          )}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragCard ? (
            <div className={`card overlay ${drag?.type === 'card' && drag.ids.length > 1 ? 'stack' : ''}`} dir={dir}>
              <div className="card-body">
                <CardFace card={dragCard} view={view} count={drag?.type === 'card' ? drag.ids.length : 1} />
              </div>
            </div>
          ) : dragCol ? (
            <div className="column overlay" dir={dir}>
              <header className="column-head">
                <h2 className="column-name">{dragCol.name}</h2>
              </header>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {selection.length > 0 && canEdit && (
        <div className="selection-bar" role="toolbar" aria-label={t('selection')}>
          <span className="selection-count">{t('nSelected', { n: selection.length })}</span>
          <button className="primary" onClick={() => setMoving(selection)}>
            {t('moveTo')}
          </button>
          <button
            onClick={() => {
              void archiveCards(view.id, selection)
              setSelection([])
            }}
          >
            {t('archive')}
          </button>
          <button className="link" onClick={() => setSelection([])}>
            {t('clearSelection')}
          </button>
        </div>
      )}

      {openCard && view.cards.get(openCard) && (
        <CardDetail view={view} cardId={openCard} onClose={() => setOpenCard(null)} onMove={(id) => (setOpenCard(null), setMoving([id]))} />
      )}
      {moving && (
        <MoveDialog
          view={view}
          ids={moving}
          onClose={(done) => {
            setMoving(null)
            if (done) setSelection([])
          }}
        />
      )}
    </div>
  )
}
