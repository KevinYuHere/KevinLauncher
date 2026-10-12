import { useEffect, useRef, type RefObject } from 'react'
import { addTask, makeSpring, springSettled, stepSpring } from './spring'

/**
 * Highly reusable "jelly" motion for any element: animates a springy position +
 * a press bulge + an inertia-driven axis-aligned stretch (no rotation). Give it
 * the target position (`x`/`y`) and whether it is pressed; it writes the element's
 * `transform` itself (so callers must not set `transform` via React).
 *
 * Used by the segmented highlight; the same hook can drive buttons, toggles, etc.
 */
interface JellyOptions {
  /** Target translation in px. */
  x?: number
  y?: number
  /** Long-press / grabbed state → bulges the element. */
  pressed?: boolean
  bulge?: number
  maxStretch?: number
  stretchK?: number
  baseScaleX?: number
  baseScaleY?: number
}

export function useJelly(ref: RefObject<HTMLElement | null>, options: JellyOptions): void {
  const opts = useRef(options)
  opts.current = options
  const s = useRef({
    pos: makeSpring(options.x ?? 0),
    posy: makeSpring(options.y ?? 0),
    pop: makeSpring(1),
    deform: makeSpring(0),
    u: 1,
    task: false
  })

  const ensure = (): void => {
    const st = s.current
    if (st.task) return
    st.task = true
    addTask((dt) => {
      const o = opts.current
      st.pos.target = o.x ?? 0
      st.posy.target = o.y ?? 0
      st.pop.target = o.pressed ? (o.bulge ?? 1.1) : 1
      // Inertia: stretch along the direction of travel, squeeze across it.
      const speed = Math.hypot(st.pos.vel, st.posy.vel)
      st.deform.target = Math.min(o.maxStretch ?? 0.2, speed * (o.stretchK ?? 0.008))
      const denom = Math.abs(st.pos.vel) + Math.abs(st.posy.vel) + 1e-4
      if (speed > 12) st.u = (Math.abs(st.pos.vel) - Math.abs(st.posy.vel)) / denom
      stepSpring(st.pos, dt)
      stepSpring(st.posy, dt)
      // Same tuning as the drag hook so every jelly effect feels identical.
      stepSpring(st.pop, dt, 240, 7)
      stepSpring(st.deform, dt, 620, 20)
      const el = ref.current
      if (el) {
        const a = st.deform.v
        const sx = (1 + st.u * a) * st.pop.v * (o.baseScaleX ?? 1)
        const sy = (1 - st.u * a) * st.pop.v * (o.baseScaleY ?? 1)
        el.style.transform = `translate(${st.pos.v.toFixed(2)}px, ${st.posy.v.toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`
      }
      const settled =
        springSettled(st.pos, 0.2, 0.4) &&
        springSettled(st.posy, 0.2, 0.4) &&
        springSettled(st.pop) &&
        springSettled(st.deform)
      if (settled) {
        st.task = false
        return false
      }
      return true
    })
  }

  const mounted = useRef(false)
  const prevPressed = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      // First appearance: jump straight to the target position (no slide-in when
      // the page opens); only subsequent value changes animate.
      mounted.current = true
      s.current.pos.v = options.x ?? 0
      s.current.posy.v = options.y ?? 0
    }
    // On release, guarantee a visible pop even for a very short tap.
    if (prevPressed.current && !options.pressed) {
      const bulge = options.bulge ?? 1.1
      if (s.current.pop.v < 1 + (bulge - 1) * 0.4) s.current.pop.v = 1 + (bulge - 1) * 0.7
    }
    prevPressed.current = !!options.pressed
    ensure()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.x, options.y, options.pressed])
}
