import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react'
import { useJelly } from '../drag/useJelly'

/**
 * iOS-style switch: the knob can be tapped *or dragged* across the track with
 * the pointer (release past the midpoint commits the new state). Uses the
 * current glass material + a brightness-darkened fill.
 */
interface SwitchProps {
  checked: boolean
  onChange: (value: boolean) => void
  label?: ReactNode
  title?: string
  disabled?: boolean
}

/** Knob travel in px (track 38 − knob 16 − 2×3 padding). */
const TRAVEL = 16

export default function Switch({
  checked,
  onChange,
  label,
  title,
  disabled
}: SwitchProps): ReactElement {
  const [drag, setDrag] = useState<number | null>(null)
  const startX = useRef(0)
  const base = useRef(0)
  const moved = useRef(false)
  // The latest offset, kept in a ref so the commit never reads a stale state.
  const offsetRef = useRef(0)
  // The state committed so far during this drag (for live switching).
  const committed = useRef(false)
  const knobRef = useRef<HTMLSpanElement>(null)

  const onPointerDown = (event: PointerEvent<HTMLSpanElement>): void => {
    if (disabled) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
    startX.current = event.clientX
    base.current = checked ? TRAVEL : 0
    moved.current = false
    committed.current = checked
    offsetRef.current = base.current
    setDrag(base.current)
  }

  const onPointerMove = (event: PointerEvent<HTMLSpanElement>): void => {
    if (drag === null) return
    const delta = event.clientX - startX.current
    if (Math.abs(delta) > 3) moved.current = true
    const offset = Math.max(0, Math.min(TRAVEL, base.current + delta))
    offsetRef.current = offset
    setDrag(offset)
    // Switch live as soon as the knob crosses the midpoint — no release needed.
    const next = offset >= TRAVEL / 2
    if (moved.current && next !== committed.current) {
      committed.current = next
      onChange(next)
    }
  }

  const finish = (): void => {
    if (drag === null) return
    setDrag(null)
    // A tap toggles; a drag already committed live in onPointerMove.
    if (!moved.current) onChange(!checked)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (disabled) return
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      onChange(!checked)
    }
  }

  const offset = drag === null ? (checked ? TRAVEL : 0) : drag
  // Only the knob pops (jelly), not the track — kept subtle.
  useJelly(knobRef, { x: offset, pressed: drag !== null, bulge: 1.1, maxStretch: 0.12 })

  return (
    <span className={`switch${disabled ? ' disabled' : ''}`} title={title}>
      <span
        className="switch-track"
        data-on={checked ? 'true' : 'false'}
        data-dragging={drag === null ? 'false' : 'true'}
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onKeyDown={onKeyDown}
      >
        {/* transform (position + jelly pop) is driven by useJelly. */}
        <span ref={knobRef} className="switch-knob" />
      </span>
      {label != null && <span>{label}</span>}
    </span>
  )
}
