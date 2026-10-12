import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { useJelly } from '../drag/useJelly'

export interface SegmentedOption {
  value: string
  label: ReactNode
}

interface SegmentedProps {
  options: SegmentedOption[]
  value: string
  onChange: (value: string) => void
  /** Visual variant: the small pill (`seg`) or the page tab bar (`tab`). */
  variant?: 'seg' | 'tab'
  title?: string
}

interface Stop {
  value: string
  x: number
  width: number
}

/**
 * Multi-choice control with a soft-body highlight. The pill *slides* between
 * options (springy) and bulges vertically while pressed — and it can be **dragged**
 * straight onto an option (like a slider), snapping to the nearest one. Stops are
 * measured from the live layout so it stays correct on resize / label changes.
 */
export default function Segmented({
  options,
  value,
  onChange,
  variant = 'seg',
  title
}: SegmentedProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLSpanElement>(null)
  const stopsRef = useRef<Stop[]>([])
  const [thumb, setThumb] = useState<{ x: number; width: number } | null>(null)
  const [dragX, setDragX] = useState<number | null>(null)
  const [pressing, setPressing] = useState(false)
  const drag = useRef<{ startX: number; baseX: number; moved: boolean } | null>(null)
  const base = variant === 'tab' ? 'tab' : 'seg'

  const measure = useCallback((): void => {
    const el = ref.current
    if (!el) return
    const buttons = Array.from(el.querySelectorAll<HTMLElement>('[data-seg]'))
    stopsRef.current = buttons.map((button) => ({
      value: button.dataset.seg ?? '',
      x: button.offsetLeft,
      width: button.offsetWidth
    }))
    const active = buttons.find((button) => button.dataset.active === 'true')
    if (active) setThumb({ x: active.offsetLeft, width: active.offsetWidth })
  }, [])

  useLayoutEffect(() => {
    measure()
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure, value, options])

  const nearest = (x: number): Stop | undefined => {
    let best: Stop | undefined
    for (const stop of stopsRef.current) {
      if (!best || Math.abs(stop.x - x) < Math.abs(best.x - x)) best = stop
    }
    return best
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (options.length < 2) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* ignore (e.g. non-primary/synthetic pointers) */
    }
    drag.current = { startX: event.clientX, baseX: thumb?.x ?? 0, moved: false }
    setPressing(true)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (!state) return
    const delta = event.clientX - state.startX
    if (Math.abs(delta) > 4) state.moved = true
    const stops = stopsRef.current
    if (!stops.length) return
    const min = stops[0].x
    const max = stops[stops.length - 1].x
    const x = Math.min(max, Math.max(min, state.baseX + delta))
    setDragX(x)
    const pick = nearest(x)
    if (pick && pick.value !== value) onChange(pick.value)
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    drag.current = null
    setDragX(null)
    setPressing(false)
    if (!state) return
    if (state.moved) return // a drag already selected the nearest option live
    // A plain click/tap: select the option under the pointer. The pointer is in
    // viewport coordinates, the stops in container coordinates → convert first.
    const rect = ref.current?.getBoundingClientRect()
    const localX = event.clientX - (rect?.left ?? 0)
    const stops = stopsRef.current
    let best: Stop | undefined
    let bestDist = Infinity
    for (const stop of stops) {
      const dist = Math.abs(stop.x + stop.width / 2 - localX)
      if (dist < bestDist) {
        bestDist = dist
        best = stop
      }
    }
    if (best && best.value !== value) onChange(best.value)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = options.findIndex((option) => option.value === value)
    if (index < 0) return
    if (event.key === 'ArrowRight') onChange(options[Math.min(options.length - 1, index + 1)].value)
    else if (event.key === 'ArrowLeft') onChange(options[Math.max(0, index - 1)].value)
  }

  const thumbX = dragX ?? thumb?.x ?? 0
  // Themed highlight gets the same jelly feel (press bulge, springy slide, settle).
  useJelly(thumbRef, { x: thumbX, pressed: pressing, bulge: 1.2, maxStretch: 0.46 })

  return (
    <div
      ref={ref}
      className={(variant === 'tab' ? 'tabs' : 'segmented') + (pressing ? ' pressing' : '')}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      {thumb && <span ref={thumbRef} className={`${base}-thumb`} style={{ width: thumb.width }} />}
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          data-seg={option.value}
          data-active={option.value === value}
          className={`${base}${option.value === value ? ' active' : ''}`}
          // Pointer clicks are handled by the container's pointerup (pointer
          // capture retargets the click); this only serves keyboard activation.
          onClick={(event) => {
            if (event.detail === 0) onChange(option.value)
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
