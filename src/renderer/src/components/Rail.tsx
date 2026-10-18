import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import Icon, { type IconName } from './Icon'
import { useJelly } from '../drag/useJelly'
import type { ViewId } from '../viewTypes'

// Left navigation rail. The active highlight is a *moving* themed thumb plus a
// moving left bar (both animated with the shared jelly springs), so the rail
// behaves like a vertical segmented control. Settings is pinned to the bottom,
// with the launcher-update indicator just above it.
interface RailProps {
  view: ViewId
  onNavigate: (view: ViewId) => void
  showGacha: boolean
  showUpdate: boolean
  updateSlot?: ReactNode
}

interface RailEntry {
  id: ViewId
  icon: IconName
  label: string
  visible: boolean
}

export default function Rail({
  view,
  onNavigate,
  showGacha,
  showUpdate,
  updateSlot
}: RailProps): ReactElement {
  const entries: RailEntry[] = [
    { id: 'home', icon: 'home', label: '主页', visible: true },
    { id: 'playtime', icon: 'clock', label: '使用时长', visible: true },
    { id: 'gacha', icon: 'gacha', label: '抽卡记录', visible: showGacha },
    { id: 'gallery', icon: 'gallery', label: '图库', visible: true },
    { id: 'update', icon: 'update', label: '更新', visible: showUpdate },
    { id: 'modules', icon: 'modules', label: '模块管理', visible: true }
  ]

  const navRef = useRef<HTMLElement>(null)
  const itemRefs = useRef<Partial<Record<ViewId, HTMLButtonElement | null>>>({})
  const thumbRef = useRef<HTMLSpanElement>(null)
  const barRef = useRef<HTMLSpanElement>(null)
  const [geom, setGeom] = useState<{ top: number; h: number } | null>(null)
  const [pressed, setPressed] = useState(false)
  const viewRef = useRef(view)
  viewRef.current = view

  // Drag-to-select (same feel as the segmented control): pick the item under the
  // pointer while dragging, live.
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    // Only start a drag-select when the press lands on one of the nav items;
    // pressing the launcher-update indicator (which also carries `.rail-item`)
    // or the spacer must not snap the selection to 设置.
    const target = event.target as HTMLElement
    const onNavItem = Object.values(itemRefs.current).some((el) => el?.contains(target))
    if (!onNavItem) return
    setPressed(true)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
    const pick = (y: number): void => {
      let best: ViewId | null = null
      let bestDist = Infinity
      for (const id of Object.keys(itemRefs.current) as ViewId[]) {
        const el = itemRefs.current[id]
        if (!el) continue
        const r = el.getBoundingClientRect()
        const dist = Math.abs(r.top + r.height / 2 - y)
        if (dist < bestDist) {
          bestDist = dist
          best = id
        }
      }
      if (best && best !== viewRef.current) onNavigate(best)
    }
    pick(event.clientY)
    const move = (e: PointerEvent): void => pick(e.clientY)
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setPressed(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  useEffect(() => {
    const measure = (): void => {
      const el = itemRefs.current[view]
      if (!el) return setGeom(null)
      setGeom({ top: el.offsetTop, h: el.offsetHeight })
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (navRef.current) ro.observe(navRef.current)
    return () => ro.disconnect()
  }, [view, showGacha, showUpdate])

  // Same jelly feature as the segmented control: springy slide + press bulge.
  useJelly(thumbRef, { y: geom ? geom.top : 0, pressed, bulge: 1.18 })
  useJelly(barRef, { y: geom ? geom.top + (geom.h - 22) / 2 : 0, pressed, bulge: 1.1 })

  const ref = (id: ViewId) => (el: HTMLButtonElement | null): void => {
    itemRefs.current[id] = el
  }

  return (
    <nav
      className="rail"
      ref={navRef}
      onPointerDown={onPointerDown}
      onPointerCancel={() => setPressed(false)}
    >
      {/* Real element (not a pseudo) so the material engine can filter it. */}
      <div className="rail-glass" aria-hidden="true" />
      {geom && (
        <>
          <span
            ref={thumbRef}
            className="rail-thumb"
            aria-hidden="true"
            style={{ height: geom.h }}
          />
          <span ref={barRef} className="rail-bar" aria-hidden="true" />
        </>
      )}
      {entries
        .filter((e) => e.visible)
        .map((e) => (
          <button
            key={e.id}
            ref={ref(e.id)}
            className={`rail-item${view === e.id ? ' active' : ''}`}
            title={e.label}
            onClick={() => onNavigate(e.id)}
          >
            <Icon name={e.icon} />
          </button>
        ))}

      <div className="rail-spacer" />

      {updateSlot}

      <button
        ref={ref('linkedLaunch')}
        className={`rail-item${view === 'linkedLaunch' ? ' active' : ''}`}
        title="关联启动"
        onClick={() => onNavigate('linkedLaunch')}
      >
        <Icon name="link" />
      </button>

      <button
        ref={ref('settings')}
        className={`rail-item${view === 'settings' ? ' active' : ''}`}
        title="设置"
        onClick={() => onNavigate('settings')}
      >
        <Icon name="settings" />
      </button>
    </nav>
  )
}
