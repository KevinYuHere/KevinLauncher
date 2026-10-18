import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type RefObject
} from 'react'
import { useJellyDrag } from '../drag/useJellyDrag'

export interface SortableHandle {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  dragging: boolean
}

interface SortableProps<T> {
  items: T[]
  getKey: (item: T) => string
  onReorder: (ids: string[]) => void
  renderItem: (item: T, index: number, handle: SortableHandle) => ReactNode
  /** Drag axis. Defaults to vertical. */
  orientation?: 'vertical' | 'horizontal'
  /** Start the drag from anywhere in the row (chips) instead of a grip. */
  dragWhole?: boolean
  /** Scroll container driven when the pointer nears its edge. */
  scrollRef?: RefObject<HTMLElement | null>
  className?: string
  onDragEnd?: () => void
}

/**
 * The single drag-sort implementation used everywhere (game icons, games-bar
 * capsules, launch methods, wallpapers …). Reuses the shared jelly drag (with
 * FLIP on reorder) and gives the neighbours an **animated** yield. While
 * dragging, the nearest scroll container auto-scrolls when the pointer reaches
 * its edge.
 */
export default function Sortable<T>({
  items,
  getKey,
  onReorder,
  renderItem,
  orientation = 'vertical',
  dragWhole = false,
  scrollRef,
  className,
  onDragEnd
}: SortableProps<T>): ReactElement {
  const refs = useRef<(HTMLDivElement | null)[]>([])
  const [order, setOrder] = useState<string[]>(() => items.map(getKey))
  useEffect(() => {
    setOrder((prev) => {
      const ids = items.map(getKey)
      // Mirror the incoming order exactly so an external reorder (e.g. the same
      // list edited elsewhere) is reflected here too.
      if (prev.length === ids.length && prev.every((id, i) => id === ids[i])) return prev
      return ids
    })
  }, [items, getKey])

  const byKey = useMemo(() => new Map(items.map((it) => [getKey(it), it])), [items, getKey])
  const ordered = order.map((k) => byKey.get(k)).filter((x): x is T => x !== undefined)

  const [source, setSource] = useState<number | null>(null)
  const [target, setTarget] = useState<number | null>(null)
  const [settlingId, setSettlingId] = useState<string | null>(null)
  const [flipping, setFlipping] = useState(false)
  const flipRects = useRef<Map<string, DOMRect> | null>(null)

  const sourceRef = useRef<number | null>(null)
  const centers = useRef<{ x: number; y: number }[] | null>(null)
  const pointer = useRef({ x: 0, y: 0 })
  const rafRef = useRef(0)
  const containerRef = useRef<HTMLDivElement>(null)

  const axis = orientation === 'horizontal' ? 'x' : 'y'

  const scrollEl = useCallback((): HTMLElement | null => {
    if (scrollRef?.current) return scrollRef.current
    let el = containerRef.current?.parentElement ?? null
    while (el) {
      const style = getComputedStyle(el)
      const canScrollY = (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight
      const canScrollX = (style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth
      if (canScrollY || canScrollX) return el
      el = el.parentElement
    }
    return null
  }, [scrollRef])

  const recomputeTarget = useCallback(
    (index: number) => {
      const list = centers.current
      if (!list) return
      let best = index
      let bestDist = Infinity
      list.forEach((c, i) => {
        const dist = Math.abs((axis === 'x' ? c.x : c.y) - (axis === 'x' ? pointer.current.x : pointer.current.y))
        if (dist < bestDist) {
          bestDist = dist
          best = i
        }
      })
      setTarget(best)
    },
    [axis]
  )

  // Auto-scroll while dragging.
  useEffect(() => {
    const tick = (): void => {
      if (sourceRef.current === null) {
        rafRef.current = 0
        return
      }
      const el = scrollEl()
      if (el) {
        const r = el.getBoundingClientRect()
        const EDGE = 48
        let dx = 0
        let dy = 0
        if (axis === 'x') {
          if (pointer.current.x > r.right - EDGE) dx = Math.min(24, (pointer.current.x - (r.right - EDGE)) / 2)
          else if (pointer.current.x < r.left + EDGE) dx = -Math.min(24, (r.left + EDGE - pointer.current.x) / 2)
          if (dx) {
            const before = el.scrollLeft
            el.scrollLeft += dx
            const delta = el.scrollLeft - before
            if (delta && centers.current) for (const c of centers.current) c.x -= delta
          }
        } else {
          if (pointer.current.y > r.bottom - EDGE) dy = Math.min(24, (pointer.current.y - (r.bottom - EDGE)) / 2)
          else if (pointer.current.y < r.top + EDGE) dy = -Math.min(24, (r.top + EDGE - pointer.current.y) / 2)
          if (dy) {
            const before = el.scrollTop
            el.scrollTop += dy
            const delta = el.scrollTop - before
            if (delta && centers.current) for (const c of centers.current) c.y -= delta
          }
        }
        if (dx || dy) recomputeTarget(sourceRef.current)
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    if (source !== null && rafRef.current === 0) rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [source, axis, scrollEl, recomputeTarget])

  useLayoutEffect(() => {
    const prev = flipRects.current
    flipRects.current = null
    if (!prev) return
    ordered.forEach((item, idx) => {
      const el = refs.current[idx]
      if (!el) return
      const before = prev.get(getKey(item))
      if (!before) return
      el.style.transition = 'none'
      el.style.transform = ''
      const now = el.getBoundingClientRect()
      const d = axis === 'x' ? before.left - now.left : before.top - now.top
      if (Math.abs(d) < 1) {
        el.style.transition = ''
        return
      }
      el.style.transform = axis === 'x' ? `translateX(${d}px)` : `translateY(${d}px)`
      requestAnimationFrame(() => {
        el.style.transition = ''
        el.style.transform = ''
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered])

  const commit = (from: number, to: number): void => {
    if (from === to) return
    const ids = ordered.map(getKey)
    const [moved] = ids.splice(from, 1)
    ids.splice(to, 0, moved)
    setOrder(ids)
    onReorder(ids)
  }

  const onDrag = (index: number, clientX: number, clientY: number): void => {
    pointer.current = { x: clientX, y: clientY }
    if (sourceRef.current === null) {
      sourceRef.current = index
      setSource(index)
    }
    if (!centers.current) {
      centers.current = refs.current.map((el) => {
        if (!el) return { x: NaN, y: NaN }
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })
    }
    recomputeTarget(index)
  }

  const onDrop = (index: number): void => {
    const item = ordered[index]
    const key = item ? getKey(item) : ''
    if (key) {
      setSettlingId(key)
      window.setTimeout(() => setSettlingId((s) => (s === key ? null : s)), 700)
    }
    const rects = new Map<string, DOMRect>()
    ordered.forEach((item, i) => {
      const el = refs.current[i]
      if (el) rects.set(getKey(item), el.getBoundingClientRect())
    })
    flipRects.current = rects
    setFlipping(true)
    window.setTimeout(() => {
      setFlipping(false)
      onDragEnd?.()
    }, 460)
    commit(index, target ?? index)
    centers.current = null
    sourceRef.current = null
    setSource(null)
    setTarget(null)
  }

  const step = (): number => {
    const el = refs.current[source ?? 0]
    if (!el) return 80
    return (axis === 'x' ? el.offsetWidth : el.offsetHeight) + 8
  }
  const shiftFor = (i: number): number => {
    if (source === null || target === null || i === source) return 0
    if (source < target && i > source && i <= target) return -step()
    if (source > target && i >= target && i < source) return step()
    return 0
  }

  return (
    <div
      ref={containerRef}
      className={`sortable sortable-${orientation}${className ? ' ' + className : ''}`}
    >
      {ordered.map((item, index) => (
        <SortableRow
          key={getKey(item)}
          orientation={orientation}
          dragWhole={dragWhole}
          dragging={source === index}
          shift={shiftFor(index)}
          settling={settlingId === getKey(item)}
          flipping={flipping}
          scrollRef={scrollRef}
          register={(el) => {
            refs.current[index] = el
          }}
          onDrag={onDrag}
          onDrop={onDrop}
          index={index}
        >
          {(handle) => renderItem(item, index, handle)}
        </SortableRow>
      ))}
    </div>
  )
}

interface SortableRowProps {
  index: number
  orientation: 'vertical' | 'horizontal'
  dragWhole: boolean
  dragging: boolean
  shift: number
  settling: boolean
  flipping: boolean
  scrollRef?: RefObject<HTMLElement | null>
  register: (el: HTMLDivElement | null) => void
  onDrag: (index: number, clientX: number, clientY: number) => void
  onDrop: (index: number) => void
  children: (handle: SortableHandle) => ReactNode
}

function SortableRow({
  index,
  orientation,
  dragWhole,
  dragging,
  shift,
  settling,
  flipping,
  scrollRef,
  register,
  onDrag,
  onDrop,
  children
}: SortableRowProps): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)
  const { onPointerDown } = useJellyDrag(ref as RefObject<HTMLElement>, {
    enabled: true,
    mode: 'translate',
    stiffness: 700,
    damping: 34,
    popScale: dragWhole ? 1.14 : 1.02,
    maxStretch: dragWhole ? 0.3 : 0.2,
    snapOnRelease: true,
    scrollRef,
    onDrag: (_dx, _dy, cx, cy) => onDrag(index, cx, cy),
    onDrop: () => onDrop(index)
  })

  const style: CSSProperties | undefined =
    !dragging && !settling && !flipping && shift !== 0
      ? orientation === 'horizontal'
        ? { transform: `translateX(${shift}px)` }
        : { transform: `translateY(${shift}px)` }
      : undefined

  return (
    <div
      ref={(el) => {
        ref.current = el
        register(el)
      }}
      className={`sortable-row${dragging ? ' dragging' : ''}`}
      style={style}
    >
      {children({ onPointerDown, dragging })}
    </div>
  )
}
