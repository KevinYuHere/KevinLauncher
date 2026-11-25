import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
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
    setClosing(true)
    window.setTimeout(() => {
      setOpen(false)
      setClosing(false)
    }, 150)
  }, [])

  const toggle = useCallback((): void => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - 12
    const above = r.top - 12
    const up = below < 220 && above > below
    const maxHeight = Math.max(140, Math.min(300, up ? above : below))
    const left = Math.max(8, Math.min(window.innerWidth - r.width - 8, r.left))
    setRect({ left, top: up ? r.top - 6 : r.bottom + 6, width: r.width, up, maxHeight })
    setOpen((v) => !v)
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      requestClose()
    }
    const close = (): void => requestClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('resize', close)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', close)
    }
  }, [open, requestClose])

  const current = options.find((o) => o.value === value)

  return (
    <div className="select-box">
      <button
        ref={triggerRef}
        type="button"
        className={`select-trigger${open ? ' open' : ''}`}
        disabled={disabled}
        onClick={toggle}
      >
        <span className="select-value">{current ? current.label : (placeholder ?? '请选择')}</span>
        <span className="select-caret">▾</span>
      </button>
      {(open || closing) &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
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
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`select-option${o.value === value ? ' active' : ''}`}
                onClick={() => {
                  onChange(o.value)
                  requestClose()
                }}
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
