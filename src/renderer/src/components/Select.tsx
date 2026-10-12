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
}

/** A frosted, theme-aware dropdown (replaces the unstyled native <select>). */
export default function Select({
  value,
  options,
  onChange,
  placeholder
}: SelectProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null)
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
    setRect({ left: r.left, top: r.bottom + 6, width: r.width })
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
            className={`select-menu${closing ? ' closing' : ''}`}
            style={{ left: rect.left, top: rect.top, width: rect.width }}
          >
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
                {o.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}
