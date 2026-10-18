import type { ReactElement } from 'react'
import type { AppEntry } from '@shared/types'
import { iconUrl } from '../media'
import Icon from './Icon'
import Sortable from './Sortable'

interface GamesRowProps {
  apps: AppEntry[]
  currentId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onReorder: (ids: string[]) => void
  /** Called once a chip drag has fully settled (so the row can auto-collapse). */
  onDragEnd?: () => void
}

/**
 * The top-left game chips. Drag-sorting uses the shared `Sortable` (jelly +
 * animated yield + FLIP), so it behaves identically to every other sortable in
 * the app.
 */
export default function GamesRow({
  apps,
  currentId,
  onSelect,
  onAdd,
  onReorder,
  onDragEnd
}: GamesRowProps): ReactElement {
  return (
    <div className="games">
      <Sortable
        orientation="horizontal"
        dragWhole
        items={apps}
        getKey={(app) => app.id}
        onReorder={onReorder}
        onDragEnd={onDragEnd}
        renderItem={(app, _index, handle) => {
          const icon = iconUrl(app.iconFile)
          return (
            <button
              draggable={false}
              className={`game-chip${app.id === currentId ? ' active' : ''}${handle.dragging ? ' dragging' : ''}`}
              title={`${app.name}（拖动可排序）`}
              onClick={() => onSelect(app.id)}
              onPointerDown={handle.onPointerDown}
            >
              {icon ? (
                <img src={icon} alt="" draggable={false} />
              ) : (
                <span>{(app.name[0] ?? '?').toUpperCase()}</span>
              )}
            </button>
          )
        }}
      />
      <button className="game-add" title="添加应用" onClick={onAdd}>
        <Icon name="plus" size={20} />
      </button>
    </div>
  )
}
