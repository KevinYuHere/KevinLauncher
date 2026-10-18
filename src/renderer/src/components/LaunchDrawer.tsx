import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import ScrollText from './ScrollText'

export interface DrawerOption {
  id: string
  label: string
}

interface LaunchDrawerProps {
  /** The button this drawer belongs to (viewport coords). */
  anchor: DOMRect
  /** Home stage (the drawer is positioned inside it, so it stays below the button). */
  bounds: DOMRect
  /** Corner radius matching the button (half its height). */
  radius: number
  /** The other choices (the button itself is the default). */
  options: DrawerOption[]
  /** Reports which choice the pointer is over: 'default', an option id, or null. */
  onHighlight: (id: string | null) => void
  /** A choice was picked: an option id or 'default'. */
  onPick: (id: string) => void
  /** Dismissed without a choice. */
  onClose: () => void
  /** Playing the retract animation (stay mounted until it finishes). */
  closing?: boolean
}

/**
 * A drawer that expands from a launch button and, together with the button,
 * forms a single-choice control. Opens above the button (flipping below when
 * there is no room) and hugs it, the tucked edge hidden behind the button.
 * The wallpaper-region layer stays fixed while the option list scrolls; when the
 * list is long, holding near an edge auto-scrolls it (then the button's default
 * becomes reachable again).
 */
export default function LaunchDrawer({
  anchor,
  bounds,
  radius,
  options,
  onHighlight,
  onPick,
  onClose,
  closing
}: LaunchDrawerProps): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [pos, setPos] = useState<{
    left: number
    top: number
    width: number
    flip: boolean
  } | null>(null)
  const width = anchor.width
  // The tucked edge reaches past the button's widest point (its vertical middle)
  // so the two shapes join cleanly; the nearest option keeps its own gap.
  const overlap = Math.max(6, Math.round(anchor.height * 0.62))
  const gap = 8
  const [highlight, setHighlightState] = useState<string | null>('default')
  // The effect below must run only once (on open): keep the latest options in a
  // ref so a re-render (e.g. while auto-scrolling) never restarts it.
  const optionsRef = useRef(options)
  optionsRef.current = options

  const setHighlight = (id: string | null): void => {
    setHighlightState(id)
    onHighlight(id)
  }

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const h = panel.offsetHeight
    const anchorTop = anchor.top - bounds.top
    const anchorBottom = anchor.bottom - bounds.top
    let top = anchorTop + overlap - h
    let flip = false
    if (top < 8) {
      top = anchorBottom - overlap
      flip = true
    }
    top = Math.max(8, Math.min(bounds.height - h - 8, top))
    let left = anchor.left - bounds.left
    left = Math.max(8, Math.min(bounds.width - width - 8, left))
    setPos({ left, top, width, flip })
  }, [anchor, bounds, width, overlap, options.length])

  // Follow the long-press pointer; auto-scroll the list near its edges.
  useEffect(() => {
    const pointer = { x: anchor.left + anchor.width / 2, y: anchor.top + anchor.height / 2 }
    let done = false
    // Auto-scroll only near the list's edges; the edge nearest the button
    // ignores its first contact (moving from the button onto the options) so it
    // does not scroll; afterwards scrolling is normal.
    let ignoreFirstNear = true
    let raf = 0
    const hit = (): string | null => {
      // Options only count while the pointer is inside the list's *visible* area:
      // elements clipped below the scroll viewport still have a rect that can
      // overlap the button, which used to steal the "default" hit.
      const sc = scrollRef.current
      const sr = sc?.getBoundingClientRect()
      if (sr && pointer.y >= sr.top && pointer.y <= sr.bottom) {
        for (let i = 0; i < optionRefs.current.length; i++) {
          const el = optionRefs.current[i]
          if (!el) continue
          const r = el.getBoundingClientRect()
          if (
            pointer.x >= r.left &&
            pointer.x <= r.right &&
            pointer.y >= r.top &&
            pointer.y <= r.bottom
          )
            return optionsRef.current[i].id
        }
      }
      if (
        pointer.x >= anchor.left + 3 &&
        pointer.x <= anchor.right - 3 &&
        pointer.y >= anchor.top + 3 &&
        pointer.y <= anchor.bottom - 3
      )
        return 'default'
      return null
    }
    const tick = (): void => {
      if (done) return
      const sc = scrollRef.current
      if (sc) {
        const r = sc.getBoundingClientRect()
        const EDGE = 30
        const panel = panelRef.current
        // Which edge of the list is nearest the button (the drawer may open above
        // or below it): that edge ignores the first contact so moving from the
        // button onto the options never scrolls.
        const drawerBelow = panel ? panel.getBoundingClientRect().top >= anchor.top : false
        const nearIsBottom = !drawerBelow
        // "near" = the list edge beside the button; the opposite edge is "far".
        // The button's own area is excluded from both, so it never scrolls
        // whichever side the drawer opened on.
        const nearBand: [number, number] = nearIsBottom
          ? [r.bottom - EDGE, anchor.top]
          : [anchor.bottom, r.top + EDGE]
        const farBand: [number, number] = nearIsBottom
          ? [r.top, r.top + EDGE]
          : [r.bottom - EDGE, r.bottom]
        const inNear = pointer.y >= nearBand[0] && pointer.y <= nearBand[1]
        const inFar = pointer.y >= farBand[0] && pointer.y <= farBand[1]
        const inUp = nearIsBottom ? inFar : inNear
        const inDown = nearIsBottom ? inNear : inFar
        const max = sc.scrollHeight - sc.clientHeight
        // Speed eases in with how far the pointer is into the band, so it stays
        // slow near the boundary and you can pull back out to stop where you want.
        const speed = (depth: number): number =>
          0.8 + Math.min(1, Math.max(0, depth)) ** 3 * 4.2
        // Peak at the list's edge and fall off on both sides, so the slack beside
        // the button is slow too (and symmetric for above/below drawers).
        const depthAt = (edge: number): number =>
          Math.min(1, Math.max(0, 1 - Math.abs(pointer.y - edge) / EDGE))
        let moved = false
        if (inDown && !(nearIsBottom && ignoreFirstNear) && sc.scrollTop < max) {
          sc.scrollTop = Math.min(max, sc.scrollTop + speed(depthAt(r.bottom)))
          moved = true
        }
        if (inUp && !(!nearIsBottom && ignoreFirstNear) && sc.scrollTop > 0) {
          sc.scrollTop = Math.max(0, sc.scrollTop - speed(depthAt(r.top)))
          moved = true
        }
        // Arm normal scrolling once the pointer is inside the list, away from the
        // near edge (the button's own area never arms it).
        if (pointer.y >= r.top && pointer.y <= r.bottom && !inNear) ignoreFirstNear = false
        if (moved) setHighlight(hit())
      }
      raf = requestAnimationFrame(tick)
    }
    const onMove = (event: PointerEvent): void => {
      pointer.x = event.clientX
      pointer.y = event.clientY
      setHighlight(hit())
    }
    const onUp = (event: PointerEvent): void => {
      done = true
      cancelAnimationFrame(raf)
      remove()
      pointer.x = event.clientX
      pointer.y = event.clientY
      const id = hit()
      if (id) onPick(id)
      else onClose()
    }
    function remove(): void {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    raf = requestAnimationFrame(tick)
    return () => {
      done = true
      cancelAnimationFrame(raf)
      remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Outside click retracts (the button is not "outside").
  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (panelRef.current?.contains(target)) return
      if (
        event.clientX >= anchor.left &&
        event.clientX <= anchor.right &&
        event.clientY >= anchor.top &&
        event.clientY <= anchor.bottom
      )
        return
      onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [onClose, anchor])

  return (
    <div
      ref={panelRef}
      className={`launch-drawer wallpaper-region${closing ? ' closing' : ''}`}
      style={{
        left: pos ? `${pos.left}px` : '-9999px',
        top: pos ? `${pos.top}px` : '-9999px',
        width: `${width}px`,
        paddingTop: pos?.flip ? `${overlap + gap}px` : '8px',
        paddingBottom: pos?.flip ? '8px' : `${overlap + gap}px`,
        borderRadius: `${radius}px`,
        visibility: pos ? 'visible' : 'hidden'
      }}
    >
      <span className="wp-region-layer" aria-hidden="true" />
      <div ref={scrollRef} className="drawer-scroll">
        {options.map((option, index) => (
          <button
            key={option.id}
            ref={(el) => {
              optionRefs.current[index] = el
            }}
            type="button"
            className="drawer-opt"
            data-active={highlight === option.id ? 'true' : 'false'}
            onClick={() => onPick(option.id)}
          >
            <ScrollText text={option.label} />
          </button>
        ))}
      </div>
    </div>
  )
}
