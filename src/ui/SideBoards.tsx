import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
} from '@dnd-kit/core'
import { getEngine, navigate } from '../state/store'
import { createBoard, createCategory, deleteCategory, placeBoard, renameCategory } from '../state/actions'
import { groupBoards, toggleCollapsed, useCollapsed, useGrouping, type CategoryItem } from '../state/categories'
import { useBoardIds } from './hooks'
import { useT } from './i18n'
import { NewThing } from './NewThing'

/** Drop target ids: `cat:<category id>`, or `cat:` for the main list. */
const MAIN = 'cat:'

let lastDragAt = 0
const justDragged = () => Date.now() - lastDragAt < 350

// the pointer decides; fall back to overlap for drops just outside a section
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  return hits.length > 0 ? hits : rectIntersection(args)
}

/**
 * The sidebar's boards: the main list, then collapsible categories. Whoever
 * may organize them (workspace admins; anyone for personal boards) drags a
 * board onto a category, or back onto the main list. Board options offer the
 * same through a menu for keyboard users.
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

  const nameOf = (id: string) => engine.boardName(id) || t('untitledBoard')
  const targetName = (over: string) =>
    over === MAIN ? t('boards') : (g.categories.find((c) => `cat:${c.id}` === over)?.name ?? '')
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
        {dragging && loose.length === 0 && <p className="side-drop-hint">{t('dropToMainList')}</p>}
      </Section>

      {shownGroups.map(({ category, ids }) => (
        <CategorySection
          key={category.id}
          ws={ws}
          category={category}
          ids={ids}
          openId={openId}
          canManage={g.canManage}
          collapsed={collapsed.includes(category.id)}
        />
      ))}

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
          <div className="side-board side-board-overlay">
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
  const { setNodeRef, listeners, isDragging } = useDraggable({ id, disabled: !draggable })
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
}

function CategorySection({ ws, category, ids, openId, canManage, collapsed }: CategoryProps) {
  const t = useT()
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
    <Section id={`cat:${category.id}`} className="side-cat">
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
          <button className="side-cat-toggle" aria-expanded={!collapsed} onClick={() => toggleCollapsed(category.id)}>
            <svg className="side-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="side-cat-name" dir="auto">
              {category.name}
            </span>
            <span className="side-count">{ids.length}</span>
          </button>
        )}
        {canManage && !renaming && (
          <details className="menu side-cat-menu">
            <summary aria-label={t('categoryOptions', { name: category.name })}>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="3" cy="8" r="1.4" fill="currentColor" />
                <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                <circle cx="13" cy="8" r="1.4" fill="currentColor" />
              </svg>
            </summary>
            <div className="menu-pop">
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
    </Section>
  )
}
