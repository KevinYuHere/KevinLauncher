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
      title={value || placeholder || '点击选择路径'}
      aria-label={value ? `当前路径：${value}。点击更换` : (placeholder || '未选择路径，点击选择')}
      onClick={onPick}
    >
      <span className={`path-field-text${value ? '' : ' empty'}`}>{value || placeholder || '未选择路径'}</span>
      <span className="path-field-icon">
        <Icon name="folder" size={16} />
      </span>
    </button>
  )
}
