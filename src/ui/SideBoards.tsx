import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { getEngine, navigate } from '../state/store'
import { createBoard, createCategory, deleteCategory, placeBoard, renameCategory } from '../state/actions'
import {
  groupBoards,
  setCategoryOrder,
  toggleCollapsed,
  useCollapsed,
  useGrouping,
  type CategoryItem,
} from '../state/categories'
import { useBoardIds } from './hooks'
import { useT } from './i18n'
import { NewThing } from './NewThing'

/**
 * Ids: a board is dragged by its own id; a category is a sortable `cat:<id>`,
 * which is also where boards drop; `cat:` alone is the main list.
 */
const MAIN = 'cat:'
const isCategoryDrag = (data: unknown) => (data as { type?: string } | undefined)?.type === 'category'

let lastDragAt = 0
const justDragged = () => Date.now() - lastDragAt < 350

const collision: CollisionDetection = (args) => {
  // a category being reordered lands among the other categories
  if (isCategoryDrag(args.active.data.current)) {
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => isCategoryDrag(c.data.current)),
    })
  }
  // a board: the pointer decides; fall back to overlap for drops just outside a section
  const hits = pointerWithin(args)
  return hits.length > 0 ? hits : rectIntersection(args)
}

/**
 * The sidebar's boards: the main list, then collapsible categories. Whoever
 * may organize them (workspace admins; anyone for personal boards) drags a
 * board onto a category, or back onto the main list. Board options offer the
 * same through a menu for keyboard users. Anyone reorders the categories by
 * dragging their headers (or Move up/down in their menu); that order is kept
 * on this device only.
 */
export function SideBoards({ ws, openId }: { ws: string | null; openId: string | null }) {
  const t = useT()
  const engine = getEngine()
  const boards = useBoardIds(ws)
  const g = useGrouping(ws)
  const collapsed = useCollapsed()
  const { loose, groups } = groupBoards(boards, g)
  const [dragging, setDragging] = useState<string | null>(null)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  )

  const categoryName = (sortId: string) => g.categories.find((c) => `cat:${c.id}` === sortId)?.name ?? ''
  const nameOf = (id: string) => (id.startsWith(MAIN) ? categoryName(id) : engine.boardName(id) || t('untitledBoard'))
  const targetName = (over: string) => (over === MAIN ? t('boards') : categoryName(over))
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('dndPicked', { name: nameOf(String(active.id)) }),
    onDragOver: ({ active, over }) =>
      over
        ? t('dndOver', { name: nameOf(String(active.id)), target: targetName(String(over.id)) })
        : t('dndNotOver', { name: nameOf(String(active.id)) }),
    onDragEnd: ({ active, over }) =>
      over
        ? t('dndDropped', { name: nameOf(String(active.id)), target: targetName(String(over.id)) })
        : t('dndCancelled', { name: nameOf(String(active.id)) }),
    onDragCancel: ({ active }) => t('dndCancelled', { name: nameOf(String(active.id)) }),
  }

  // people who cannot organize see only the categories holding boards they follow
  const shownGroups = g.canManage ? groups : groups.filter((x) => x.ids.length > 0)
  const shownIds = shownGroups.map((x) => x.category.id)
  /** Move a category next to a visible neighbour; hidden empty ones keep their place. */
  const moveTo = (id: string, neighbour: string) => {
    const all = g.categories.map((c) => c.id)
    setCategoryOrder(ws, arrayMove(all, all.indexOf(id), all.indexOf(neighbour)))
  }
  const moveBy = (id: string, by: number) => {
    const neighbour = shownIds[shownIds.indexOf(id) + by]
    if (neighbour) moveTo(id, neighbour)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      accessibility={{ announcements, screenReaderInstructions: { draggable: '' } }}
      onDragStart={({ active }) => setDragging(String(active.id))}
      onDragCancel={() => setDragging(null)}
      onDragEnd={({ active, over }) => {
        lastDragAt = Date.now()
        setDragging(null)
        if (!over) return
        if (isCategoryDrag(active.data.current)) {
          if (over.id !== active.id) moveTo(String(active.id).slice(MAIN.length), String(over.id).slice(MAIN.length))
          return
        }
        const board = String(active.id)
        const category = String(over.id).slice(MAIN.length) || null
        if (category !== g.placeOf(board)) void placeBoard(ws, board, category)
      }}
    >
      <Section id={MAIN} className="side-main">
        <h2 className="side-title">{t('boards')}</h2>
        {boards.length === 0 && <p className="side-empty">{t('noBoardsYet')}</p>}
        {loose.length > 0 && (
          <ul>
            {loose.map((id) => (
              <BoardRow key={id} id={id} active={openId === id} draggable={g.canManage} />
            ))}
          </ul>
        )}
        {dragging && !dragging.startsWith(MAIN) && loose.length === 0 && (
          <p className="side-drop-hint">{t('dropToMainList')}</p>
        )}
      </Section>

      <SortableContext items={shownIds.map((id) => `cat:${id}`)} strategy={verticalListSortingStrategy}>
        {shownGroups.map(({ category, ids }, i) => (
          <CategorySection
            key={category.id}
            ws={ws}
            category={category}
            ids={ids}
            openId={openId}
            canManage={g.canManage}
            collapsed={collapsed.includes(category.id)}
            onMove={i > 0 || i < shownGroups.length - 1 ? (by) => moveBy(category.id, by) : undefined}
            first={i === 0}
            last={i === shownGroups.length - 1}
          />
        ))}
      </SortableContext>

      <div className="side-actions">
        <NewThing label={t('newBoard')} placeholder={t('boardName')} onCreate={(name) => void createBoard(name, ws)} />
        {g.canManage && (
          <NewThing label={t('newCategory')} placeholder={t('categoryName')} onCreate={(name) => void createCategory(ws, name)} />
        )}
        <button className="side-add" onClick={() => navigate({ name: 'join', code: '' })}>
          {t('joinWithInvite')}
        </button>
      </div>

      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div className={`side-board side-board-overlay ${dragging.startsWith(MAIN) ? 'category' : ''}`}>
            <span className="side-board-name" dir="auto">
              {nameOf(dragging)}
            </span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}

function Section({ id, className, children }: { id: string; className: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <div ref={setNodeRef} className={`${className} ${isOver ? 'drop-over' : ''}`}>
      {children}
    </div>
  )
}

function BoardRow({ id, active, draggable }: { id: string; active: boolean; draggable: boolean }) {
  const t = useT()
  const engine = getEngine()
  const { setNodeRef, listeners, isDragging } = useDraggable({ id, data: { type: 'board' }, disabled: !draggable })
  const v = engine.view(id)
  const waiting = !v || v.myRole === 'none'
  return (
    <li ref={setNodeRef} className={isDragging ? 'side-dragging' : undefined}>
      <button
        className={`side-board ${active ? 'active' : ''} ${draggable ? 'can-drag' : ''}`}
        {...listeners}
        onClick={() => !justDragged() && navigate({ name: 'board', id })}
        aria-current={active ? 'page' : undefined}
      >
        <span className="side-board-name" dir="auto">
          {engine.boardName(id) || t('untitledBoard')}
        </span>
        {waiting && <span className="side-pending">{t('pending')}</span>}
      </button>
    </li>
  )
}

interface CategoryProps {
  ws: string | null
  category: CategoryItem
  ids: string[]
  openId: string | null
  canManage: boolean
  collapsed: boolean
  /** Move up (-1) or down (+1) among the visible categories; absent when there is only one */
  onMove?(by: number): void
  first: boolean
  last: boolean
}

function CategorySection({ ws, category, ids, openId, canManage, collapsed, onMove, first, last }: CategoryProps) {
  const t = useT()
  const sortable = useSortable({ id: `cat:${category.id}`, data: { type: 'category' } })
  // boards dropping in tint it; categories being reordered just make room
  const boardOver = sortable.isOver && !isCategoryDrag(sortable.active?.data.current)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(category.name)
  // a collapsed category still shows the board that is open
  const shown = collapsed ? ids.filter((id) => id === openId) : ids
  const close = (e: React.MouseEvent) => (e.currentTarget.closest('details') as HTMLDetailsElement).removeAttribute('open')
  const finishRename = () => {
    setRenaming(false)
    if (name.trim() && name.trim() !== category.name) void renameCategory(ws, category.id, name.trim())
    else setName(category.name)
  }

  return (
    <div
      ref={sortable.setNodeRef}
      style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }}
      className={`side-cat ${boardOver ? 'drop-over' : ''} ${sortable.isDragging ? 'side-dragging' : ''}`}
    >
      <div className="side-cat-head">
        {renaming ? (
          <form
            className="side-new"
            onSubmit={(e) => {
              e.preventDefault()
              finishRename()
            }}
          >
            <input
              autoFocus
              value={name}
              maxLength={80}
              aria-label={t('categoryName')}
              onChange={(e) => setName(e.target.value)}
              onBlur={finishRename}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                setName(category.name)
                setRenaming(false)
              }}
            />
          </form>
        ) : (
          <button
            ref={sortable.setActivatorNodeRef}
            className="side-cat-toggle"
            {...sortable.listeners}
            aria-expanded={!collapsed}
            // the click that ends a drag of this header is swallowed by dnd-kit
            onClick={() => toggleCollapsed(category.id)}
          >
            <svg className="side-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="side-cat-name" dir="auto">
              {category.name}
            </span>
            <span className="side-count">{ids.length}</span>
          </button>
        )}
        {(canManage || onMove) && !renaming && (
          <details className="menu side-cat-menu">
            <summary aria-label={t('categoryOptions', { name: category.name })}>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="3" cy="8" r="1.4" fill="currentColor" />
                <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                <circle cx="13" cy="8" r="1.4" fill="currentColor" />
              </svg>
            </summary>
            <div className="menu-pop">
              {onMove && (
                <>
                  <button disabled={first} onClick={(e) => (close(e), onMove(-1))}>
                    {t('moveUp')}
                  </button>
                  <button disabled={last} onClick={(e) => (close(e), onMove(1))}>
                    {t('moveDown')}
                  </button>
                </>
              )}
              {canManage && (
                <>
                  <button onClick={(e) => (close(e), setRenaming(true))}>{t('rename')}</button>
                  <button
                    className="danger"
                    onClick={(e) => {
                      close(e)
                      const ask = ws ? 'deleteCompanyCategoryConfirm' : 'deleteCategoryConfirm'
                      if (confirm(t(ask, { name: category.name }))) void deleteCategory(ws, category.id)
                    }}
                  >
                    {t('deleteCategory')}
                  </button>
                </>
              )}
            </div>
          </details>
        )}
      </div>
      {shown.length > 0 && (
        <ul>
          {shown.map((id) => (
            <BoardRow key={id} id={id} active={openId === id} draggable={canManage} />
          ))}
        </ul>
      )}
      {!collapsed && ids.length === 0 && canManage && <p className="side-drop-hint">{t('dragBoardsHere')}</p>}
    </div>
  )
}
