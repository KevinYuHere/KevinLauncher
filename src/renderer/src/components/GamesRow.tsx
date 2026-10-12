import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject
} from 'react'
import type { AppEntry } from '@shared/types'
import { useJellyDrag } from '../drag/useJellyDrag'
import { iconUrl } from '../media'
import Icon from './Icon'

interface GamesRowProps {
  apps: AppEntry[]
  currentId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onReorder: (ids: string[]) => void
  /** Called once a chip drag has fully settled (so the row can auto-collapse). */
  onDragEnd?: () => void
}

interface ChipProps {
  app: AppEntry
  index: number
  active: boolean
  isSource: boolean
  shift: number
  /** While the just-dropped chip settles, the hook owns its transform. */
  settling: boolean
  /** During the FLIP reorder animation React must not write transforms. */
  flipping: boolean
  register: (index: number, el: HTMLButtonElement | null) => void
  onDrag: (index: number, dx: number, dy: number, cx: number, cy: number) => void
  onDrop: (index: number, dx: number, dy: number, cx: number, cy: number) => void
  onSelect: (id: string) => void
}

function GameChip({
  app,
  index,
  active,
  isSource,
  shift,
  settling,
  flipping,
  register,
  onDrag,
  onDrop,
  onSelect
}: ChipProps): ReactElement {
  const ref = useRef<HTMLButtonElement | null>(null)
  const grabbed = useRef(false)
  const { onPointerDown } = useJellyDrag(ref as RefObject<HTMLElement>, {
    enabled: true,
    mode: 'translate',
    // More damping so the release doesn't overshoot wildly on the small chips.
    stiffness: 700,
    damping: 34,
    popScale: 1.3,
    maxStretch: 0.46,
    snapOnRelease: true,
    onDrag: (dx, dy, cx, cy) => {
      grabbed.current = true
      onDrag(index, dx, dy, cx, cy)
    },
    onDrop: (dx, dy, cx, cy) => {
      if (grabbed.current) onDrop(index, dx, dy, cx, cy)
      grabbed.current = false
    }
  })
  const icon = iconUrl(app.iconFile)
  return (
    <button
      ref={(el) => {
        ref.current = el
        register(index, el)
      }}
      draggable={false}
      className={`game-chip${active ? ' active' : ''}${isSource ? ' dragging' : ''}`}
      title={`${app.name}（拖动可排序）`}
      style={!isSource && !settling && !flipping ? { transform: `translateX(${shift}px)` } : undefined}
      onClick={() => onSelect(app.id)}
      onPointerDown={onPointerDown}
    >
      {icon ? <img src={icon} alt="" draggable={false} /> : <span>{(app.name[0] ?? '?').toUpperCase()}</span>}
    </button>
  )
}

export default function GamesRow({
  apps,
  currentId,
  onSelect,
  onAdd,
  onReorder,
  onDragEnd
}: GamesRowProps): ReactElement {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const baseCenters = useRef<number[] | null>(null)
  // Local order so a reorder happens synchronously (the FLIP must run in the same
  // layout pass; persisting through IPC is async and caused a visible jump back).
  const [order, setOrder] = useState<string[]>(() => apps.map((a) => a.id))
  useEffect(() => {
    setOrder((prev) => {
      const ids = apps.map((a) => a.id)
      const kept = prev.filter((id) => ids.includes(id))
      const added = ids.filter((id) => !kept.includes(id))
      return [...kept, ...added]
    })
  }, [apps])
  const ordered = useMemo(
    () => order.map((id) => apps.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a),
    [order, apps]
  )
  const [source, setSource] = useState<number | null>(null)
  const [target, setTarget] = useState<number | null>(null)
  const [settlingId, setSettlingId] = useState<string | null>(null)
  const [flipping, setFlipping] = useState(false)
  const flipRects = useRef<Map<string, DOMRect> | null>(null)

  // FLIP: after a reorder, animate each chip from its old rect to the new one
  // (instead of the DOM order jumping instantly).
  useLayoutEffect(() => {
    const prev = flipRects.current
    flipRects.current = null
    if (!prev) return
    ordered.forEach((app, idx) => {
      const el = refs.current[idx]
      if (!el) return
      const before = prev.get(app.id)
      if (!before) return
      el.style.transition = 'none'
      // Drop the hook's leftover transform so `now` is the real (new) base.
      el.style.transform = ''
      const now = el.getBoundingClientRect()
      const dx = before.left - now.left
      const dy = before.top - now.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
        el.style.transition = ''
        return
      }
      el.style.transform = `translate(${dx}px, ${dy}px)`
      requestAnimationFrame(() => {
        el.style.transition = ''
        el.style.transform = ''
      })
    })
    // Don't clear this on re-render (apps can change again quickly, which used
    // to leave `flipping` stuck true and disabled the yield transforms).
  }, [ordered])

  const commit = (from: number, to: number): void => {
    if (from === to) return
    const ids = ordered.map((a) => a.id)
    const [moved] = ids.splice(from, 1)
    ids.splice(to, 0, moved)
    setOrder(ids) // synchronous → FLIP runs in the same layout pass
    onReorder(ids)
  }

  const register = (index: number, el: HTMLButtonElement | null): void => {
    refs.current[index] = el
  }

  const onDrag = (index: number, _dx: number, _dy: number, clientX: number): void => {
    if (source === null) setSource(index)
    // Capture each chip's base centre once (before any gap shift) and pick the
    // target from the *pointer* — using the transformed rect would feed back and
    // make the target jump around.
    if (!baseCenters.current) {
      baseCenters.current = refs.current.map((el) =>
        el ? el.getBoundingClientRect().left + el.offsetWidth / 2 : NaN
      )
    }
    const centers = baseCenters.current
    let best = index
    let bestDist = Infinity
    // Include the source's own slot too, otherwise dragging back to the original
    // position always snaps to a neighbour and the icon can't be put back.
    centers.forEach((c, i) => {
      if (Number.isNaN(c)) return
      const dist = Math.abs(c - clientX)
      if (dist < bestDist) {
        bestDist = dist
        best = i
      }
    })
    setTarget(best)
  }

  const onDrop = (index: number, _dx: number, _dy: number, _cx: number, _cy: number): void => {
    const id = ordered[index]?.id
    if (id) {
      setSettlingId(id)
      window.setTimeout(() => setSettlingId((s) => (s === id ? null : s)), 700)
    }
    const rects = new Map<string, DOMRect>()
    ordered.forEach((a, i) => {
      const el = refs.current[i]
      if (el) rects.set(a.id, el.getBoundingClientRect())
    })
    flipRects.current = rects
    setFlipping(true)
    // Always clear `flipping` (even if no reorder happens, so the yield transforms
    // are never permanently skipped).
    window.setTimeout(() => {
      setFlipping(false)
      onDragEnd?.()
    }, 460)
    commit(index, target ?? index)
    baseCenters.current = null
    setSource(null)
    setTarget(null)
  }

  const step = (): number => {
    const el = refs.current[0]
    return el ? el.offsetWidth + 10 : 56
  }

  const shiftFor = (i: number): number => {
    if (source === null || target === null || i === source) return 0
    if (source < target && i > source && i <= target) return -step()
    if (source > target && i >= target && i < source) return step()
    return 0
  }

  return (
    <div className={`games${source !== null ? ' row-dragging' : ''}`}>
      {ordered.map((app, index) => (
        <GameChip
          key={app.id}
          app={app}
          index={index}
          active={app.id === currentId}
          isSource={source === index}
          shift={shiftFor(index)}
          settling={settlingId === app.id}
          flipping={flipping}
          register={register}
          onDrag={onDrag}
          onDrop={onDrop}
          onSelect={onSelect}
        />
      ))}
      <button className="game-add" title="添加应用" onClick={onAdd}>
        <Icon name="plus" size={20} />
      </button>
    </div>
  )
}
