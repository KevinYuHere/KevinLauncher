import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { addTask, makeSpring, stepSpring } from './spring'

/**
 * Reusable "jelly" pointer-drag. Framework-agnostic and page-agnostic: give it an
 * element ref; it drives a springy, axis-aligned deformation (no rotation, centre
 * fixed) and reports drag deltas so any page can reposition / reflow.
 *
 * - press/long-press bulges the element (spring "pop");
 * - dragging stretches along the motion and squeezes across it (inertia-driven);
 * - release springs back with a bounce.
 *
 * `mode: 'position'` — the consumer moves the element itself (left/top); the hook
 * only applies the scale. `mode: 'translate'` — the hook also applies the drag
 * translation (useful when the base position is layout-driven, e.g. a flex row).
 */

interface JellyDragOptions {
  enabled: boolean
  mode?: 'translate' | 'position'
  threshold?: number
  maxStretch?: number
  stretchK?: number
  popScale?: number
  /** Spring stiffness / damping for the position + deform springs. */
  stiffness?: number
  damping?: number
  /** Clear the transform immediately on release (let a FLIP animation take over). */
  snapOnRelease?: boolean
  /** Scroll container whose scroll offset is added to the drag (so the dragged
   *  element keeps following the pointer while the container auto-scrolls). */
  scrollRef?: RefObject<HTMLElement | null>
  onDrag?: (dx: number, dy: number, clientX: number, clientY: number) => void
  onDrop?: (dx: number, dy: number, clientX: number, clientY: number) => void
  onCancel?: () => void
}

export function useJellyDrag(
  ref: RefObject<HTMLElement>,
  options: JellyDragOptions
): { onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void } {
  const opts = useRef(options)
  opts.current = options
  const st = useRef({
    drag: null as null | {
      px: number
      py: number
      lx: number
      ly: number
      lt: number
      vx: number
      vy: number
      active: boolean
      dx: number
      dy: number
    },
    deform: makeSpring(0),
    pop: makeSpring(1),
    tx: makeSpring(0),
    ty: makeSpring(0),
    task: false,
    halt: false,
    angle: 0
  })

  const ensureTask = (): void => {
    const s = st.current
    if (s.task) return
    s.task = true
    addTask((dt) => {
      if (s.halt) {
        // Frozen on release (a FLIP animation owns it now) — stop without clearing.
        s.task = false
        return false
      }
      const k = opts.current.stiffness ?? 760
      const c = opts.current.damping ?? 20
      stepSpring(s.deform, dt, k, c)
      // Lightly damped so a press "ripples" (stretch→overshoot-contract→…).
      stepSpring(s.pop, dt, 240, 7)
      stepSpring(s.tx, dt, k, c)
      stepSpring(s.ty, dt, k, c)
      const el = ref.current
      const d = s.drag
      const u = d ? (Math.abs(d.vx) - Math.abs(d.vy)) / (Math.abs(d.vx) + Math.abs(d.vy) + 1e-4) : 0
      const a = s.deform.v
      const sx = (1 + u * a) * s.pop.v
      const sy = (1 - u * a) * s.pop.v
      const mode = opts.current.mode ?? 'translate'
      const tx = mode === 'translate' ? s.tx.v : 0
      const ty = mode === 'translate' ? s.ty.v : 0
      if (el) {
        el.style.transform =
          mode === 'translate'
            ? `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`
            : `scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`
      }
      const settled =
        !d &&
        Math.abs(s.deform.v) < 0.002 &&
        Math.abs(s.deform.vel) < 0.02 &&
        Math.abs(s.pop.v - 1) < 0.002 &&
        Math.abs(s.pop.vel) < 0.02 &&
        Math.abs(s.tx.v) < 0.3 &&
        Math.abs(s.tx.vel) < 0.3 &&
        Math.abs(s.ty.v) < 0.3 &&
        Math.abs(s.ty.vel) < 0.3
      if (settled) {
        if (el) el.style.transform = ''
        s.task = false
        return false
      }
      return true
    })
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    const s = st.current
    s.halt = false
    const bulge = opts.current.popScale ?? 1.1
    // Press bulge happens even when dragging is disabled (so a plain click on a
    // non-draggable module/icon still pops). Do NOT reset pop.v — springing from
    // wherever it is makes interrupting a settling pop smooth.
    s.pop.target = bulge
    ensureTask()
    if (!opts.current.enabled) {
      const release = (): void => {
        window.removeEventListener('pointerup', release)
        window.removeEventListener('pointercancel', release)
        // Guarantee a visible pop even for a very short tap.
        s.pop.v = Math.max(s.pop.v, 1 + (bulge - 1) * 0.6)
        s.pop.target = 1
        ensureTask()
      }
      window.addEventListener('pointerup', release)
      window.addEventListener('pointercancel', release)
      return
    }
    event.preventDefault()
    // Resolve the scroll container once (explicit ref, else nearest scrollable
    // ancestor) and remember where it started.
    const scrollEl = (): HTMLElement | null => {
      const explicit = opts.current.scrollRef?.current
      if (explicit) return explicit
      let el = ref.current?.parentElement ?? null
      while (el) {
        const cs = getComputedStyle(el)
        const canX =
          (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth
        const canY =
          (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight
        if (canX || canY) return el
        el = el.parentElement
      }
      return null
    }
    const scroller = scrollEl()
    const startScroll = scroller
      ? { left: scroller.scrollLeft, top: scroller.scrollTop }
      : { left: 0, top: 0 }
    s.drag = {
      px: event.clientX,
      py: event.clientY,
      lx: event.clientX,
      ly: event.clientY,
      lt: performance.now(),
      vx: 0,
      vy: 0,
      active: false,
      dx: 0,
      dy: 0
    }
    s.deform.v = 0
    s.deform.vel = 0
    s.deform.target = 0

    const move = (e: PointerEvent): void => {
      const d = s.drag
      if (!d) return
      // Add the container's scroll delta so the element follows the pointer even
      // while the container scrolls underneath it.
      const sc = scroller ?? scrollEl()
      const sdx = sc ? sc.scrollLeft - startScroll.left : 0
      const sdy = sc ? sc.scrollTop - startScroll.top : 0
      const dx = e.clientX - d.px + sdx
      const dy = e.clientY - d.py + sdy
      if (!d.active) {
        // Dragging may be disabled by the consumer mid-gesture (e.g. a long
        // press opened a picker and now owns the pointer) — never activate then.
        if (!opts.current.enabled) return
        if (Math.hypot(dx, dy) < (opts.current.threshold ?? 4)) return
        d.active = true
        s.pop.target = opts.current.popScale ?? 1.06
        // Capture on activation (after the tap threshold, so plain taps still
        // reach inner buttons) — keeps pointer events flowing even when the
        // cursor leaves the window.
        try {
          ref.current?.setPointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
      }
      d.dx = dx
      d.dy = dy
      const now = performance.now()
      const dt = Math.max(1, now - d.lt)
      d.vx += ((e.clientX - d.lx) / dt - d.vx) * 0.4
      d.vy += ((e.clientY - d.ly) / dt - d.vy) * 0.4
      d.lx = e.clientX
      d.ly = e.clientY
      d.lt = now
      const speed = Math.hypot(d.vx, d.vy)
      s.deform.target = Math.min(opts.current.maxStretch ?? 0.22, speed * (opts.current.stretchK ?? 0.09))
      if ((opts.current.mode ?? 'translate') === 'translate') {
        // Follow the pointer 1:1 — keep the spring target equal to the delta so
        // it never eases back toward 0 mid-drag (that caused jitter).
        s.tx.v = dx
        s.ty.v = dy
        s.tx.target = dx
        s.ty.target = dy
        s.tx.vel = 0
        s.ty.vel = 0
      }
      if (d.active) opts.current.onDrag?.(dx, dy, e.clientX, e.clientY)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      const d = s.drag
      s.drag = null
      // Only a real drag snaps (so a FLIP can take over); a tap must keep the
      // element so its pop can animate out.
      if (opts.current.snapOnRelease && d?.active) {
        // Report the drop FIRST (the consumer captures the current, dragged rects
        // for the FLIP), then hand the element straight back so it can never get
        // stuck mid-animation.
        opts.current.onDrop?.(d.dx, d.dy, d.lx, d.ly)
        const el = ref.current
        if (el) el.style.transform = ''
        s.deform.v = s.deform.vel = s.deform.target = 0
        s.pop.v = 1
        s.pop.vel = 0
        s.pop.target = 1
        s.tx.v = s.tx.vel = s.tx.target = 0
        s.ty.v = s.ty.vel = s.ty.target = 0
        return
      }
      // Guarantee a visible pop even for a very short tap.
      if (d && !d.active) {
        const bulge = opts.current.popScale ?? 1.1
        s.pop.v = Math.max(s.pop.v, 1 + (bulge - 1) * 0.6)
      }
      s.deform.target = 0
      s.pop.target = 1
      s.tx.target = 0
      s.ty.target = 0
      if (d?.active) opts.current.onDrop?.(d.dx, d.dy, d.lx, d.ly)
      else opts.current.onCancel?.()
      ensureTask()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return { onPointerDown }
}
