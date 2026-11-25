import type { ReactElement } from 'react'
import Icon from './Icon'

interface PathFieldProps {
  value: string
  /** Opens a file/directory picker. */
  onPick: () => void
  placeholder?: string
  /** Extra class on the wrapper (e.g. `wide`). */
  className?: string
}

/**
 * A file/directory field: shows the chosen path (or a placeholder) and a folder
 * icon; clicking the text **or** the icon opens the picker. No text editing.
 */
export default function PathField({
  value,
  onPick,
  placeholder,
  className
}: PathFieldProps): ReactElement {
  return (
    <button
      type="button"
      className={`path-field${className ? ' ' + className : ''}`}
      title={value || placeholder || '选择'}
      onClick={onPick}
    >
      <span className={`path-field-text${value ? '' : ' empty'}`}>{value || placeholder || '未设置'}</span>
      <span className="path-field-icon">
        <Icon name="folder" size={16} />
      </span>
    </button>
  )
}
