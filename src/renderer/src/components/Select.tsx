import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

export interface SelectOption {
  value: string
  label: string
}

interface SelectProps {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  /** Shown greyed out and non-interactive (e.g. a developer-locked theme area). */
  disabled?: boolean
}

/** A frosted, theme-aware dropdown (replaces the unstyled native <select>). */
export default function Select({
  value,
  options,
  onChange,
  placeholder,
  disabled = false
}: SelectProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const id = useId()
  const closeTimer = useRef(0)
  const [rect, setRect] = useState<{
    left: number
    top: number
    width: number
    up: boolean
    maxHeight: number
  } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Play an exit animation before unmounting the menu.
  const requestClose = useCallback((): void => {
    if (closeTimer.current) return
    setClosing(true)
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = 0
      setOpen(false)
      setClosing(false)
    }, 150)
  }, [])
  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  const showMenu = (): void => {
    const el = triggerRef.current
    if (!el || options.length === 0) return
    window.clearTimeout(closeTimer.current)
    closeTimer.current = 0
    const r = el.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - 12
    const above = r.top - 12
    const up = below < 220 && above > below
    const maxHeight = Math.max(140, Math.min(300, up ? above : below))
    const left = Math.max(8, Math.min(window.innerWidth - r.width - 8, r.left))
    setRect({ left, top: up ? r.top - 6 : r.bottom + 6, width: r.width, up, maxHeight })
    setClosing(false)
    setHighlighted(Math.max(0, options.findIndex((option) => option.value === value)))
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      requestClose()
    }
    const close = (): void => requestClose()
    const onWheel = (e: WheelEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) requestClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('resize', close)
    window.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', onWheel)
    }
  }, [open, requestClose])

  const current = options.find((o) => o.value === value)
  const expanded = open && !closing
  const choose = (next: string): void => {
    onChange(next)
    requestClose()
    triggerRef.current?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!expanded) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        showMenu()
      }
      return
    }
    if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') requestClose()
      else if (options[highlighted]) choose(options[highlighted].value)
      return
    }
    const next = event.key === 'ArrowDown' ? Math.min(options.length - 1, highlighted + 1)
      : event.key === 'ArrowUp' ? Math.max(0, highlighted - 1)
      : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : null
    if (next === null) return
    event.preventDefault()
    setHighlighted(next)
    menuRef.current?.querySelectorAll('[role="option"]')[next]?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <div className="select-box">
      <button
        ref={triggerRef}
        type="button"
        className={`select-trigger${open ? ' open' : ''}`}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={expanded ? id : undefined}
        aria-activedescendant={expanded ? `${id}-${highlighted}` : undefined}
        onClick={() => { if (expanded) requestClose(); else showMenu() }}
        onKeyDown={onKeyDown}
        onBlur={() => { if (expanded) requestClose() }}
      >
        <span className="select-value">{current ? current.label : (placeholder ?? '请选择')}</span>
        <span className="select-caret">▾</span>
      </button>
      {(open || closing) &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            id={id}
            role="listbox"
            aria-hidden={closing || undefined}
            className={`select-menu wallpaper-region${closing ? ' closing' : ''}`}
            style={{
              left: rect.left,
              top: rect.top,
              width: rect.width,
              maxHeight: rect.maxHeight,
              transform: rect.up ? 'translateY(-100%)' : undefined
            }}
          >
            <span className="wp-region-layer" aria-hidden="true" />
            {options.map((o, index) => (
              <button
                key={o.value}
                id={`${id}-${index}`}
                tabIndex={-1}
                role="option"
                aria-selected={o.value === value}
                type="button"
                className={`select-option${o.value === value ? ' active' : ''}${highlighted === index ? ' highlighted' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => choose(o.value)}
              >
                <span className="select-option-label">{o.label}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}
