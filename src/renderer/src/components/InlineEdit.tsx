import { useEffect, useRef, useState, type ReactElement } from 'react'
import Icon from './Icon'

interface InlineEditProps {
  value: string
  onCommit: (value: string) => void
  placeholder?: string
  title?: string
  /** Extra class on the wrapper (e.g. to flex-grow inside a row). */
  className?: string
}

/**
 * Inline name editor: normally shows the current text with a pencil button;
 * clicking the text (or the pencil) turns it into a borderless input whose
 * underline sweeps in from the left (coloured with the current text colour).
 * The pencil becomes a check; blur or the check saves.
 */
export default function InlineEdit({
  value,
  onCommit,
  placeholder,
  title,
  className
}: InlineEditProps): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  const start = (): void => {
    setDraft(value)
    setEditing(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  const commit = (): void => {
    setEditing(false)
    if (draft.trim() !== value) onCommit(draft.trim())
    else setDraft(value)
  }
  const cancel = (): void => {
    setEditing(false)
    setDraft(value)
  }

  return (
    <span
      className={`inline-edit${editing ? ' editing' : ''}${className ? ' ' + className : ''}`}
      onClick={editing ? undefined : start}
    >
      {editing ? (
        <>
          <span className="inline-edit-field">
            <input
              ref={inputRef}
              className="inline-edit-input"
              value={draft}
              placeholder={placeholder}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') inputRef.current?.blur()
                else if (e.key === 'Escape') cancel()
              }}
            />
          </span>
          <button
            type="button"
            className="inline-edit-btn"
            title="保存"
            // Keep focus so the blur (save) runs through the same path.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => inputRef.current?.blur()}
          >
            <Icon name="check" size={16} />
          </button>
        </>
      ) : (
        <>
          <span
            className={`inline-edit-text${value ? '' : ' empty'}`}
            title={title ?? value}
          >
            {value || placeholder || '未命名'}
          </span>
          <button type="button" className="inline-edit-btn" title="编辑" onClick={start}>
            <Icon name="pencil" size={16} />
          </button>
        </>
      )}
    </span>
  )
}
