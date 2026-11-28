import { useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react'
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
  const pointerId = useRef<number | null>(null)
  const labelId = useId()
  const knobRef = useRef<HTMLSpanElement>(null)

  const onPointerDown = (event: PointerEvent<HTMLSpanElement>): void => {
    if (disabled || event.button !== 0 || pointerId.current !== null) return
    pointerId.current = event.pointerId
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
    startX.current = event.clientX
    base.current = checked ? TRAVEL : 0
    moved.current = false
    setDrag(base.current)
  }

  const onPointerMove = (event: PointerEvent<HTMLSpanElement>): void => {
    if (pointerId.current !== event.pointerId) return
    const delta = event.clientX - startX.current
    if (Math.abs(delta) > 3) moved.current = true
    const offset = Math.max(0, Math.min(TRAVEL, base.current + delta))
    setDrag(offset)
  }

  const finish = (event: PointerEvent<HTMLSpanElement>, commit: boolean): void => {
    if (pointerId.current !== event.pointerId) return
    pointerId.current = null
    setDrag(null)
    if (!commit || disabled) return
    const next = moved.current ? base.current + event.clientX - startX.current >= TRAVEL / 2 : !checked
    if (next !== checked) onChange(next)
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
        aria-labelledby={label != null ? labelId : undefined}
        aria-label={label == null ? title : undefined}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => finish(event, true)}
        onPointerCancel={(event) => finish(event, false)}
        onLostPointerCapture={(event) => finish(event, false)}
        onKeyDown={onKeyDown}
      >
        {/* transform (position + jelly pop) is driven by useJelly. */}
        <span ref={knobRef} className="switch-knob" />
      </span>
      {label != null && <span id={labelId}>{label}</span>}
    </span>
  )
}
