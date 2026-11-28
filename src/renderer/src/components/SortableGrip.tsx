import type { ReactElement } from 'react'
import type { SortableHandle } from './Sortable'
import Icon from './Icon'

interface SortableGripProps {
  handle: SortableHandle
  /**
   * Tooltip and accessible name. The HUD appends its keyboard hint here; every
   * other list uses the default copy.
   */
  label?: string
  /** Icon size in px (the linked-launch card uses a slightly larger grip). */
  size?: number
}

/**
 * The shared grip for a sortable row. Keeps the button semantics, copy, icon
 * and `.ll-grip` styling in one place; `Sortable` owns the pointer stream, the
 * dragging class and the keyboard move (which targets `.ll-grip`).
 */
export default function SortableGrip({
  handle,
  label = '拖动排序',
  size = 16
}: SortableGripProps): ReactElement {
  return (
    <button
      type="button"
      className={`ll-grip${handle.dragging ? ' dragging' : ''}`}
      title={label}
      aria-label={label}
      onPointerDown={handle.onPointerDown}
    >
      <Icon name="grip" size={size} />
    </button>
  )
}
