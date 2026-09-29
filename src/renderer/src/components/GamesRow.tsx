import { useRef, useState, type ReactElement } from 'react'
import type { AppEntry } from '@shared/types'
import { iconUrl } from '../media'
import Icon from './Icon'

// Horizontal, drag-to-reorder row of app chips shown at the top-left. The
// current app is highlighted; the trailing "+" opens the add-app dialog.
interface GamesRowProps {
  apps: AppEntry[]
  currentId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onReorder: (ids: string[]) => void
}

export default function GamesRow({
  apps,
  currentId,
  onSelect,
  onAdd,
  onReorder
}: GamesRowProps): ReactElement {
  const dragIndex = useRef<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)

  // Move the dragged chip from `from` to `to` and report the new id order.
  const commit = (from: number, to: number): void => {
    if (from === to) return
    const ids = apps.map((a) => a.id)
    const [moved] = ids.splice(from, 1)
    ids.splice(to, 0, moved)
    onReorder(ids)
  }

  return (
    <div className="games">
      {apps.map((app, index) => {
        const icon = iconUrl(app.iconFile)
        const isDropTarget = dragging && overIndex === index && dragIndex.current !== index
        const isDragged = dragging && dragIndex.current === index
        return (
          <button
            key={app.id}
            draggable
            className={`game-chip${app.id === currentId ? ' active' : ''}${
              isDropTarget ? ' drop-target' : ''
            }${isDragged ? ' dragging' : ''}`}
            title={`${app.name}（拖动可排序）`}
            onClick={() => onSelect(app.id)}
            onDragStart={(e) => {
              dragIndex.current = index
              setDragging(true)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', app.id)
            }}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (overIndex !== index) setOverIndex(index)
            }}
            onDragLeave={() => setOverIndex((v) => (v === index ? null : v))}
            onDrop={(e) => {
              e.preventDefault()
              if (dragIndex.current !== null) commit(dragIndex.current, index)
              dragIndex.current = null
              setOverIndex(null)
              setDragging(false)
            }}
            onDragEnd={() => {
              dragIndex.current = null
              setOverIndex(null)
              setDragging(false)
            }}
          >
            {icon ? <img src={icon} alt="" /> : <span>{(app.name[0] ?? '?').toUpperCase()}</span>}
          </button>
        )
      })}
      <button className="game-add" title="添加应用" onClick={onAdd}>
        <Icon name="plus" size={20} />
      </button>
    </div>
  )
}
