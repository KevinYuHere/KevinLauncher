import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type WheelEvent as ReactWheelEvent
} from 'react'
import type { LinkedLaunch } from '@shared/types'
import Sortable from './Sortable'
import ScrollText from './ScrollText'

interface LinkedLaunchRowProps {
  items: LinkedLaunch[]
  /** Only shown on the home page (faded in / out). */
  visible?: boolean
  /** Runtime keys currently running (includes `linked:<id>` tasks). */
  runningKeys: string[]
  onLaunch: (id: string, el?: HTMLElement | null) => void
  onStop: (id: string) => void
  onReorder: (ids: string[]) => void
}

/**
 * The games-bar linked-launch row: narrow capsules (width follows the name, up
 * to a max) in a horizontally scrollable strip with edge fade masks and an
 * overflow-only draggable scrollbar (which only scrolls this row). Capsules are
 * drag-sortable via the shared `Sortable` (jelly + animated yield + auto-scroll),
 * and clicking one runs (or stops) it.
 */
export default function LinkedLaunchRow({
  items,
  visible = true,
  runningKeys,
  onLaunch,
  onStop,
  onReorder
}: LinkedLaunchRowProps): ReactElement | null {
  const viewportRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  // Scrollbar geometry. `readScroll` updates immediately (scroll); resize-driven
  // changes are debounced past the collapse animation so no scrollbar flashes.
  const [scroll, setScroll] = useState({ left: 0, width: 0, max: 0, track: 0 })
  const readScroll = useCallback((): void => {
    const el = viewportRef.current
    const track = trackRef.current
    if (!el) return
    setScroll({
      left: el.scrollLeft,
      width: el.clientWidth,
      max: Math.max(0, el.scrollWidth - el.clientWidth),
      track: track?.offsetWidth ?? 0
    })
  }, [])
  const scheduleTimer = useRef(0)
  const scheduleScroll = useCallback((): void => {
    if (scheduleTimer.current) window.clearTimeout(scheduleTimer.current)
    scheduleTimer.current = window.setTimeout(readScroll, 420)
  }, [readScroll])
  useEffect(() => {
    readScroll()
    const el = viewportRef.current
    if (!el) return
    const ro = new ResizeObserver(scheduleScroll)
    ro.observe(el)
    window.addEventListener('resize', scheduleScroll)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', scheduleScroll)
      if (scheduleTimer.current) window.clearTimeout(scheduleTimer.current)
    }
  }, [readScroll, scheduleScroll, items])
  useEffect(() => {
    const id = window.setTimeout(readScroll, 420)
    return () => window.clearTimeout(id)
  }, [items, readScroll])

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    const el = viewportRef.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    el.scrollLeft += event.deltaY + event.deltaX
  }

  if (items.length === 0) return null

  return (
    <div className={`linked-row-wrap${visible ? '' : ' hidden'}`}>
      <div
        className={`linked-viewport${scroll.left > 1 ? ' fade-left' : ''}${scroll.left < scroll.max - 1 ? ' fade-right' : ''}`}
        ref={viewportRef}
        onScroll={readScroll}
        onWheel={onWheel}
      >
        <Sortable
          orientation="horizontal"
          dragWhole
          scrollRef={viewportRef}
          items={items}
          getKey={(item) => item.id}
          onReorder={onReorder}
          className="linked-row"
          renderItem={(item, _index, handle) => {
            const running = runningKeys.includes(`linked:${item.id}`)
            return (
              <button
                draggable={false}
                className={`linked-cap${running ? ' running' : ''}${handle.dragging ? ' dragging' : ''}`}
                title={running ? `停止「${item.name}」` : `启动「${item.name}」`}
                onClick={(e) => (running ? onStop(item.id) : onLaunch(item.id, e.currentTarget))}
                onPointerDown={handle.onPointerDown}
              >
                {running && <span className="linked-cap-dot" />}
                <ScrollText text={item.name} maxWidth={150} />
              </button>
            )
          }}
        />
      </div>
    </div>
  )
}
