import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject
} from 'react'
import {
  DEFAULT_HOME_MODULE,
  HOME_MODULES,
  type AddonDescriptor,
  type AppEntry,
  type HomeModuleId,
  type HomeModuleState,
  type LinkedLaunch,
  type UpdateInfo,
  type UpdateStatus
} from '@shared/types'
import { useJellyDrag } from '../drag/useJellyDrag'
import { useLongPress } from '../drag/useLongPress'
import { pushOut2D, type Rect } from '../drag/resolve'
import { showToast } from './toast'
import DownloadButton, { type DownloadTone, type RingTone } from './DownloadButton'
import LaunchDrawer, { type DrawerOption } from './LaunchDrawer'
import ScrollText from './ScrollText'
import Icon from './Icon'
import { formatBytes, formatEta, formatSpeed } from '../format'
import { useDownloadSpeed } from '../useDownloadSpeed'

interface HomeViewProps {
  entry: AppEntry
  addon: AddonDescriptor | undefined
  running: boolean
  startedAt?: string
  totalSec: number
  updateInfo: UpdateInfo | undefined
  updateStatus: UpdateStatus | null
  /** Connected linked launches (global list; filtered per app below). */
  linkedLaunches: LinkedLaunch[]
  /** Runtime keys currently running (includes `linked:<id>` tasks). */
  runningKeys: string[]
  onLaunch: (methodId?: string) => void
  onStop: () => void
  onUpdateToggle: () => void
  onPreDownloadToggle: () => void
  onShowStats: () => void
  onWallpaperStep: (delta: number) => void
  onLaunchLinked: (id: string, el?: HTMLElement | null) => void
  onStopLinked: (id: string) => void
  onMoveModule: (moduleId: HomeModuleId, x: number, y: number) => void
  /** Called when a module cannot be placed (home full) so it can be hidden. */
  onModuleUnplaceable: (moduleId: HomeModuleId) => void
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}h ${pad(m)}m` : `${m}m ${pad(s)}s`
}

function formatTotal(totalSec: number): string {
  if (totalSec <= 0) return '暂无记录'
  const hours = totalSec / 3600
  if (hours >= 1) return `${hours.toFixed(1)} 小时`
  return `${Math.max(1, Math.round(totalSec / 60))} 分钟`
}

interface Anchor {
  left?: number
  right?: number
  top?: number
  bottom?: number
}

/**
 * A home module: jelly-draggable, positioned by px anchors (default) or stored
 * fractions. Uses the shared `useJellyDrag` (springy deformation, no rotation).
 */
function HomeModule({
  moduleId,
  state,
  stageRef,
  anchor,
  live,
  shift,
  dragging,
  dragEnabled,
  raised,
  override,
  register,
  onDrag,
  onDrop,
  onMeasure,
  children
}: {
  moduleId: HomeModuleId
  state: HomeModuleState
  stageRef: RefObject<HTMLDivElement>
  anchor: Anchor
  live: { x: number; y: number } | null
  shift: { x: number; y: number } | null
  dragging: boolean
  /** Overrides `state.draggable` (e.g. suspended while a picker is open). */
  dragEnabled?: boolean
  /** Lift above the launch drawer so it can cover the drawer's tucked edge. */
  raised?: boolean
  override: { left: number; top: number } | null
  register: (id: HomeModuleId, el: HTMLDivElement | null) => void
  onDrag: (id: HomeModuleId, dx: number, dy: number) => void
  onDrop: (id: HomeModuleId, dx: number, dy: number) => void
  onMeasure?: (w: number, h: number) => void
  children: ReactNode
}): ReactElement {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const [box, setBox] = useState({ w: 0, h: 0 })
  const canDrag = dragEnabled ?? state.draggable

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = (): void => setStage({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [stageRef])

  const onMeasureRef = useRef(onMeasure)
  onMeasureRef.current = onMeasure
  useEffect(() => {
    const el = wrapRef.current
    register(moduleId, el)
    if (!el) return
    const measure = (): void => {
      const w = el.offsetWidth
      const h = el.offsetHeight
      setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
      onMeasureRef.current?.(w, h)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      ro.disconnect()
      register(moduleId, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const maxX = Math.max(0, stage.w - box.w)
  const maxY = Math.max(0, stage.h - box.h)
  const defaultLeft = anchor.left != null ? anchor.left : stage.w - box.w - (anchor.right ?? 0)
  const defaultTop = anchor.top != null ? anchor.top : stage.h - box.h - (anchor.bottom ?? 0)
  const baseLeft = state.x != null ? state.x * maxX : defaultLeft
  const baseTop = state.y != null ? state.y * maxY : defaultTop
  const settledLeft = override ? override.left : baseLeft
  const settledTop = override ? override.top : baseTop
  const left = live ? live.x : settledLeft
  const top = live ? live.y : settledTop
  const shifted = shift && (shift.x !== 0 || shift.y !== 0)

  const { onPointerDown } = useJellyDrag(wrapRef, {
    enabled: canDrag,
    mode: 'position',
    popScale: 1.2,
    maxStretch: 0.46,
    onDrag: (dx, dy) => onDrag(moduleId, dx, dy),
    onDrop: (dx, dy) => onDrop(moduleId, dx, dy)
  })

  return (
    <div
      ref={wrapRef}
      className={`home-module${canDrag ? ' draggable' : ''}${dragging ? ' dragging' : ''}${raised ? ' raised' : ''}`}
      style={{
        left: `${Math.round(left)}px`,
        top: `${Math.round(top)}px`,
        transform: !dragging && shifted ? `translate(${shift.x}px, ${shift.y}px)` : undefined
      }}
      onPointerDown={onPointerDown}
    >
      {children}
    </div>
  )
}

/** Axis-aligned overlap test with a gap (used to normalise the layout). */
function rectsOverlap(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  )
}

export default function HomeView({
  entry,
  addon,
  running,
  startedAt,
  totalSec,
  updateInfo,
  updateStatus,
  linkedLaunches,
  runningKeys,
  onLaunch,
  onStop,
  onUpdateToggle,
  onPreDownloadToggle,
  onShowStats,
  onWallpaperStep,
  onLaunchLinked,
  onStopLinked,
  onMoveModule,
  onModuleUnplaceable
}: HomeViewProps): ReactElement {
  const [now, setNow] = useState(Date.now())
  const [launchW, setLaunchW] = useState(0)
  const [linkedW, setLinkedW] = useState(0)
  const [live, setLive] = useState<Record<string, { x: number; y: number }>>({})
  const [shifts, setShifts] = useState<Record<string, { x: number; y: number }>>({})
  const [override, setOverride] = useState<Record<string, { left: number; top: number }>>({})
  const [dragId, setDragId] = useState<HomeModuleId | null>(null)
  const [picker, setPicker] = useState<{ kind: 'launch' | 'linked'; anchor: DOMRect } | null>(null)
  const [pickerClosing, setPickerClosing] = useState(false)
  const [pickHighlight, setPickHighlight] = useState<string | null>('default')
  const stageRef = useRef<HTMLDivElement>(null)
  const linkedBtnRef = useRef<HTMLButtonElement>(null)
  const refs = useRef<Partial<Record<HomeModuleId, HTMLElement | null>>>({})
  const prevVisible = useRef<string>('')

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  const speed = useDownloadSpeed(updateStatus)
  const elapsed = running && startedAt ? now - new Date(startedAt).getTime() : 0

  const status = updateStatus
  const active = !!status && (status.phase === 'downloading' || status.phase === 'extracting')
  const extracting = status?.phase === 'extracting'
  const paused = status?.phase === 'paused'
  const progress = status?.progress ?? 0
  const preActive = (active || paused) && status?.mode === 'preDownload'
  const mainActive = (active || paused) && status?.mode === 'update'
  const preAvailable = !active && !paused && !!updateInfo?.preDownloadVersion
  const updateAvailable = !!updateInfo?.hasUpdate

  const remaining =
    speed > 0 && status && status.totalBytes > 0
      ? (status.totalBytes - status.downloadedBytes) / speed
      : null

  const mod = (id: HomeModuleId): HomeModuleState => ({
    ...DEFAULT_HOME_MODULE,
    ...(entry.homeModules?.[id] ?? {})
  })
  const info = mod('info')
  const playtime = mod('playtime')
  const launch = mod('launch')
  const wallpaper = mod('wallpaper')
  const linked = mod('linkedLaunch')

  // Linked launches associated with this app (in the app's own order).
  const appLinked = useMemo(
    () =>
      entry.linkedLaunchIds
        .map((id) => linkedLaunches.find((item) => item.id === id))
        .filter((item): item is LinkedLaunch => !!item),
    [entry.linkedLaunchIds, linkedLaunches]
  )
  const defaultLinkedId = useMemo(
    () =>
      appLinked.find((item) => item.id === entry.defaultLinkedLaunchId)?.id ??
      appLinked[0]?.id ??
      null,
    [appLinked, entry.defaultLinkedLaunchId]
  )
  const defaultLinked = appLinked.find((item) => item.id === defaultLinkedId) ?? null
  const linkedRunning = defaultLinkedId ? runningKeys.includes(`linked:${defaultLinkedId}`) : false
  const linkedLabel = linkedRunning
    ? '停止'
    : picker?.kind === 'linked'
      ? (defaultLinked?.name ?? '关联启动')
      : '关联启动'

  const stageSize = (): { w: number; h: number } => {
    const el = stageRef.current
    return { w: el?.clientWidth ?? window.innerWidth, h: el?.clientHeight ?? window.innerHeight }
  }
  const register = (id: HomeModuleId, el: HTMLDivElement | null): void => {
    refs.current[id] = el
  }

  // Persist a resolved layout: the dragged module + any shoved modules.
  const persist = (moves: { id: HomeModuleId; x: number; y: number }[]): void => {
    const { w, h } = stageSize()
    for (const m of moves) {
      const el = refs.current[m.id]
      const mw = el?.offsetWidth ?? 0
      const mh = el?.offsetHeight ?? 0
      const fx = w - mw > 0 ? m.x / (w - mw) : 0
      const fy = h - mh > 0 ? m.y / (h - mh) : 0
      onMoveModule(m.id, Math.max(0, Math.min(1, fx)), Math.max(0, Math.min(1, fy)))
    }
  }

  const isVisible = (id: HomeModuleId): boolean => {
    if (!mod(id).visible) return false
    if (id === 'linkedLaunch' && appLinked.length === 0) return false
    return true
  }
  const visibleIds = (): HomeModuleId[] => HOME_MODULES.filter((m) => isVisible(m.id)).map((m) => m.id)

  // Base position captured once at drag start (the delta is relative to it).
  const baseRef = useRef<Partial<Record<HomeModuleId, { left: number; top: number }>>>({})
  const baseOf = (id: HomeModuleId, el: HTMLElement): { left: number; top: number } => {
    let base = baseRef.current[id]
    if (!base) {
      base = { left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0 }
      baseRef.current[id] = base
    }
    return base
  }

  const GAP = 14
  /** A module's *base* rect (its CSS position, ignoring any yield transform). */
  const baseRectOf = (id: HomeModuleId): Rect | null => {
    const el = refs.current[id]
    if (!el) return null
    return {
      id,
      x: parseFloat(el.style.left) || 0,
      y: parseFloat(el.style.top) || 0,
      w: el.offsetWidth,
      h: el.offsetHeight
    }
  }
  const yieldShifts = (id: HomeModuleId, target: Rect, w: number, h: number): void => {
    const others = visibleIds()
      .filter((o) => o !== id)
      .map((o) => baseRectOf(o))
      .filter((r): r is Rect => r !== null)
    const { moves } = pushOut2D(others, target, GAP, { w, h })
    const sh: Record<string, { x: number; y: number }> = {}
    for (const [mid, pos] of moves) {
      const r = others.find((o) => o.id === mid)
      if (r) sh[mid] = { x: pos.x - r.x, y: pos.y - r.y }
    }
    setShifts(sh)
  }

  const onDragModule = (id: HomeModuleId, dx: number, dy: number): void => {
    const el = refs.current[id]
    if (!el) return
    setDragId((prev) => prev ?? id)
    const base = baseOf(id, el)
    const { w, h } = stageSize()
    const maxX = Math.max(0, w - el.offsetWidth)
    const maxY = Math.max(0, h - el.offsetHeight)
    const nx = Math.max(0, Math.min(maxX, base.left + dx))
    const ny = Math.max(0, Math.min(maxY, base.top + dy))
    setLive((prev) => ({ ...prev, [id]: { x: nx, y: ny } }))
    yieldShifts(id, { id, x: nx, y: ny, w: el.offsetWidth, h: el.offsetHeight }, w, h)
  }

  const onDropModule = (id: HomeModuleId, dx: number, dy: number): void => {
    const el = refs.current[id]
    if (!el) return
    const base = baseOf(id, el)
    delete baseRef.current[id]
    const { w, h } = stageSize()
    const maxX = Math.max(0, w - el.offsetWidth)
    const maxY = Math.max(0, h - el.offsetHeight)
    const nx = Math.max(0, Math.min(maxX, base.left + dx))
    const ny = Math.max(0, Math.min(maxY, base.top + dy))
    const target: Rect = { id, x: nx, y: ny, w: el.offsetWidth, h: el.offsetHeight }
    const others = visibleIds()
      .filter((o) => o !== id)
      .map((o) => baseRectOf(o))
      .filter((r): r is Rect => r !== null)
    const { moves, resolved } = pushOut2D(others, target, GAP, { w, h })

    setLive((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setDragId(null)
    setShifts({})

    if (!resolved) {
      showToast('没有可用空间，请先隐藏或移开模块')
      return
    }
    const ov: Record<string, { left: number; top: number }> = { [id]: { left: nx, top: ny } }
    for (const [mid, pos] of moves) ov[mid] = { left: pos.x, top: pos.y }
    setOverride((prev) => ({ ...prev, ...ov }))
    const list: { id: HomeModuleId; x: number; y: number }[] = [{ id, x: nx, y: ny }]
    for (const [mid, pos] of moves) list.push({ id: mid as HomeModuleId, x: pos.x, y: pos.y })
    persist(list)
  }

  // Reflow: nudge modules apart so none is clipped/overlapping (used on resize).
  const reflow = (): void => {
    const ids = visibleIds()
    if (ids.length < 2) return
    const { w, h } = stageSize()
    const target = baseRectOf(ids[0])
    if (!target) return
    const others = ids
      .slice(1)
      .map((o) => baseRectOf(o))
      .filter((r): r is Rect => r !== null)
    const { moves, resolved } = pushOut2D(others, target, GAP, { w, h })
    if (!resolved) return
    const list: { id: HomeModuleId; x: number; y: number }[] = []
    const ov: Record<string, { left: number; top: number }> = {}
    for (const [mid, pos] of moves) {
      const r = others.find((o) => o.id === mid)
      if (r && (Math.abs(pos.x - r.x) > 1 || Math.abs(pos.y - r.y) > 1)) {
        list.push({ id: mid as HomeModuleId, x: pos.x, y: pos.y })
        ov[mid] = { left: pos.x, top: pos.y }
      }
    }
    if (list.length === 0) return
    setOverride((prev) => ({ ...prev, ...ov }))
    persist(list)
  }

  // A module's own size changed (e.g. the launch button widens when an update /
  // pre-download appears): push the neighbours away from it and persist.
  const reflowFrom = (id: HomeModuleId): void => {
    const el = refs.current[id]
    if (!el) return
    const target = baseRectOf(id)
    if (!target) return
    const { w, h } = stageSize()
    const others = visibleIds()
      .filter((o) => o !== id)
      .map((o) => baseRectOf(o))
      .filter((r): r is Rect => r !== null)
    const { moves, resolved } = pushOut2D(others, target, GAP, { w, h })
    if (!resolved) return
    const list: { id: HomeModuleId; x: number; y: number }[] = []
    const ov: Record<string, { left: number; top: number }> = {}
    for (const [mid, pos] of moves) {
      const r = others.find((o) => o.id === mid)
      if (r && (Math.abs(pos.x - r.x) > 1 || Math.abs(pos.y - r.y) > 1)) {
        list.push({ id: mid as HomeModuleId, x: pos.x, y: pos.y })
        ov[mid] = { left: pos.x, top: pos.y }
      }
    }
    if (list.length === 0) return
    setOverride((prev) => ({ ...prev, ...ov }))
    persist(list)
  }

  // On window/stage resize, drop the stale px overrides (so modules fall back to
  // their stored fractions, always in bounds) and reflow to remove overlaps.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    let timer = 0
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        setOverride({})
        setShifts({})
        setLive({})
        window.setTimeout(reflow, 80)
      }, 160)
    })
    ro.observe(el)
    return () => {
      window.clearTimeout(timer)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id])

  // Re-flow as soon as a module's *own* size changes (the launch button widens
  // when an update / pre-download appears, the linked pill when its name / order
  // changes), not only on window resize.
  useEffect(() => {
    const ids = HOME_MODULES.map((m) => m.id)
    const els = ids.map((id) => refs.current[id]).filter((el): el is HTMLDivElement => !!el)
    if (els.length === 0) return
    const sizes = new Map<HTMLElement, { w: number; h: number }>()
    let timer = 0
    let pending: HomeModuleId | null = null
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement
        const prev = sizes.get(el)
        const size = { w: el.offsetWidth, h: el.offsetHeight }
        sizes.set(el, size)
        if (!prev) continue
        if (Math.abs(prev.w - size.w) < 1 && Math.abs(prev.h - size.h) < 1) continue
        pending = ids.find((id) => refs.current[id] === el) ?? pending
      }
      if (!pending) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (pending) reflowFrom(pending)
      }, 40)
    })
    for (const el of els) ro.observe(el)
    return () => {
      window.clearTimeout(timer)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, entry.homeModules, appLinked])

  // On enable: place the newly-visible module (push others aside, or report full).
  useEffect(() => {
    const sig = visibleIds().join(',')
    const prev = prevVisible.current
    prevVisible.current = sig
    if (!prev) return
    const newly = HOME_MODULES.map((m) => m.id).find(
      (id) => isVisible(id) && !prev.split(',').includes(id)
    )
    if (!newly) return
    const timer = window.setTimeout(() => {
      const el = refs.current[newly]
      if (!el) return
      const { w, h } = stageSize()
      const r = baseRectOf(newly)
      if (!r) return
      const others = visibleIds()
        .filter((o) => o !== newly)
        .map((o) => baseRectOf(o))
        .filter((x): x is Rect => x !== null)
      const { moves, resolved } = pushOut2D(others, r, GAP, { w, h })
      if (!resolved) {
        showToast('主页已满，添加失败')
        onModuleUnplaceable(newly)
        return
      }
      const ov: Record<string, { left: number; top: number }> = { [newly]: { left: r.x, top: r.y } }
      for (const [mid, pos] of moves) ov[mid] = { left: pos.x, top: pos.y }
      setOverride((prevOv) => ({ ...prevOv, ...ov }))
      const list: { id: HomeModuleId; x: number; y: number }[] = [{ id: newly, x: r.x, y: r.y }]
      for (const [mid, pos] of moves) list.push({ id: mid as HomeModuleId, x: pos.x, y: pos.y })
      persist(list)
    }, 60)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.homeModules, entry.id, appLinked])

  // Normalise overlaps: any module sitting at its *default* anchor that overlaps
  // a neighbour (e.g. after "隐藏 → 重置位置 → 显示") gets its neighbours pushed
  // away, then the result is persisted. Modules with stored fractions are left
  // alone (the drag already resolved them).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const ids = visibleIds()
      if (ids.length < 2) return
      const rects = ids.map((id) => baseRectOf(id)).filter((r): r is Rect => r !== null)
      for (const r of rects) {
        const stored = entry.homeModules?.[r.id]
        const atDefault = !stored || stored.x == null || stored.y == null
        if (!atDefault) continue
        const clash = rects.some((o) => o.id !== r.id && rectsOverlap(o, r, 2))
        if (clash) {
          reflowFrom(r.id as HomeModuleId)
          break
        }
      }
    }, 90)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.homeModules, entry.id, appLinked])

  // Drop stale local overrides when the persisted state no longer matches it
  // (e.g. after "重置位置" sets x/y back to null, or after switching apps).
  useEffect(() => {
    setOverride((prev) => {
      let changed = false
      const next = { ...prev }
      for (const id of HOME_MODULES.map((m) => m.id)) {
        const stored = entry.homeModules?.[id]
        if (next[id] && (stored?.x == null || stored?.y == null)) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [entry.homeModules, entry.id])

  const popup = (
    <>
      <div className="dl-pop-speed">
        {extracting
          ? (status?.message ?? '正在应用更新…')
          : `${Math.floor(progress * 100)}% · ${formatSpeed(speed)}`}
      </div>
      <div className="dl-pop-row">
        <span>
          {formatBytes(status?.downloadedBytes ?? 0)} / {formatBytes(status?.totalBytes ?? 0)}
        </span>
        <span>{formatEta(remaining)}</span>
      </div>
    </>
  )

  // One launch-button shape for every mode (see DownloadButton): the cap ring
  // shows real progress with a pause / play state icon, and the label sits a
  // fixed gap to its right. In the idle state the button shows the default
  // launch method's name (the button is the "default" choice of the picker).
  const defaultMethod =
    entry.launchMethods.find((m) => m.id === entry.defaultLaunchMethodId) ??
    entry.launchMethods[0] ??
    null
  const launchIcon =
    !active && !paused && preAvailable ? <Icon name="update" size={16} /> : undefined
  let launchLabel = '启动'
  let launchTone: DownloadTone = 'plain'
  let launchProgress: number | null = null
  let launchRing: RingTone = 'pre'
  let launchClick = onLaunch
  const idleLaunch = !running && !mainActive && !updateAvailable && !preActive && !preAvailable
  if (running) {
    launchLabel = '停止'
    launchTone = 'stop'
    launchClick = onStop
  } else if (mainActive) {
    launchLabel = paused ? '已暂停' : `${Math.floor(progress * 100)}%`
    launchTone = 'update'
    launchProgress = progress
    launchRing = 'update'
    launchClick = onUpdateToggle
  } else if (updateAvailable) {
    launchLabel = '开始更新'
    launchTone = 'update'
    launchClick = onUpdateToggle
  } else if (preActive) {
    launchProgress = progress
    launchClick = onPreDownloadToggle
  } else if (preAvailable) {
    launchClick = onPreDownloadToggle
  }
  // While the drawer is open the button shows the default method's name.
  if (idleLaunch && picker?.kind === 'launch') {
    launchLabel = defaultMethod?.name?.trim() || '启动'
  }

  const methodPickerEnabled = idleLaunch && entry.launchMethods.length >= 2
  const linkedPickerEnabled = appLinked.length >= 2

  const drawerOptions: DrawerOption[] =
    picker?.kind === 'launch'
      ? entry.launchMethods
          .filter((m) => m.id !== entry.defaultLaunchMethodId)
          .map((m) => ({ id: m.id, label: m.name }))
      : appLinked.filter((l) => l.id !== defaultLinkedId).map((l) => ({ id: l.id, label: l.name }))

  const boundsRect =
    stageRef.current?.getBoundingClientRect() ??
    new DOMRect(0, 0, window.innerWidth, window.innerHeight)

  const openPicker = (kind: 'launch' | 'linked', anchor: DOMRect): void => {
    setPickerClosing(false)
    setPicker({ kind, anchor })
    setPickHighlight('default')
  }

  const closePicker = (): void => {
    if (!picker || pickerClosing) return
    setPickerClosing(true)
    window.setTimeout(() => {
      setPicker(null)
      setPickerClosing(false)
    }, 180)
  }

  const pickChoice = (id: string): void => {
    if (picker?.kind === 'launch') {
      onLaunch(id === 'default' ? undefined : id)
    } else if (id === 'default') {
      // Origin is the linked button itself (the drawer's anchor), not the window.
      if (defaultLinkedId) onLaunchLinked(defaultLinkedId, linkedBtnRef.current)
    } else {
      onLaunchLinked(id, linkedBtnRef.current)
    }
    closePicker()
  }

  const launchButtonClick = (): void => {
    if (picker?.kind === 'launch') {
      pickChoice('default')
      return
    }
    launchClick()
  }

  const onLinkedLongPress = (rect: DOMRect): void => {
    if (linkedPickerEnabled && !picker) openPicker('linked', rect)
  }
  const linkedLongPress = useLongPress(onLinkedLongPress)
  const linkedClick = (el?: HTMLElement): void => {
    if (linkedLongPress.consumeClick()) return
    if (picker?.kind === 'linked') {
      pickChoice('default')
      return
    }
    if (!defaultLinkedId) return
    if (linkedRunning) onStopLinked(defaultLinkedId)
    else onLaunchLinked(defaultLinkedId, el)
  }

  return (
    <div className="home" ref={stageRef}>
      {wallpaper.visible && (
        <HomeModule
          moduleId="wallpaper"
          state={wallpaper}
          stageRef={stageRef}
          anchor={{ left: 26, top: 26 }}
          live={live.wallpaper ?? null}
          shift={shifts.wallpaper ?? null}
          dragging={dragId === 'wallpaper'}
          override={override.wallpaper ?? null}
          register={register}
          onDrag={onDragModule}
          onDrop={onDropModule}
        >
          <div className="wallpaper-switch">
            <button
              className="wp-btn glass"
              title="上一张壁纸"
              onClick={() => onWallpaperStep(-1)}
              disabled={entry.wallpapers.length === 0}
            >
              <Icon name="chevronLeft" size={20} />
            </button>
            <button
              className="wp-btn glass"
              title="下一张壁纸"
              onClick={() => onWallpaperStep(1)}
              disabled={entry.wallpapers.length === 0}
            >
              <Icon name="chevronRight" size={20} />
            </button>
          </div>
        </HomeModule>
      )}

      {info.visible && (
        <HomeModule
          moduleId="info"
          state={info}
          stageRef={stageRef}
          anchor={{ left: 26, bottom: 26 }}
          live={live.info ?? null}
          shift={shifts.info ?? null}
          dragging={dragId === 'info'}
          override={override.info ?? null}
          register={register}
          onDrag={onDragModule}
          onDrop={onDropModule}
        >
          <div className="home-info glass">
            <div className="hi-title">{entry.name}</div>
            <div className="hi-sub">
              <span>
                {entry.moduleLabel?.trim() ? entry.moduleLabel : addon ? addon.name : '普通应用'}
              </span>
              <span className="sep" />
              <span className={running ? 'live' : ''}>{running ? '运行中' : '未运行'}</span>
            </div>
            <button className="hi-stats" onClick={onShowStats}>
              总时长 {formatTotal(totalSec)}
            </button>
          </div>
        </HomeModule>
      )}

      {playtime.visible && (
        <HomeModule
          moduleId="playtime"
          state={playtime}
          stageRef={stageRef}
          anchor={{ right: 26 + launchW + (linkedW > 0 ? linkedW + 12 : 0), bottom: 26 }}
          live={live.playtime ?? null}
          shift={shifts.playtime ?? null}
          dragging={dragId === 'playtime'}
          override={override.playtime ?? null}
          register={register}
          onDrag={onDragModule}
          onDrop={onDropModule}
        >
          <button className="playtime-pill glass" title="查看使用时间" onClick={onShowStats}>
            <Icon name="clock" size={16} />
            <span>{running ? formatDuration(elapsed) : formatTotal(totalSec)}</span>
          </button>
        </HomeModule>
      )}

      {linked.visible && appLinked.length > 0 && (
        <HomeModule
          moduleId="linkedLaunch"
          state={linked}
          stageRef={stageRef}
          anchor={{ right: 26 + launchW + 12, bottom: 26 }}
          live={live.linkedLaunch ?? null}
          shift={shifts.linkedLaunch ?? null}
          dragging={dragId === 'linkedLaunch'}
          dragEnabled={!picker}
          raised={picker?.kind === 'linked'}
          override={override.linkedLaunch ?? null}
          register={register}
          onDrag={onDragModule}
          onDrop={onDropModule}
          onMeasure={(w) => setLinkedW((prev) => (Math.abs(prev - w) > 1 ? w : prev))}
        >
          <button
            ref={linkedBtnRef}
            className={`linked-launch-pill glass${linkedRunning ? ' running' : ''}${picker?.kind === 'linked' ? ' picker-open' : ''}${picker?.kind === 'linked' && pickHighlight === 'default' ? ' selected' : ''}`}
            title={
              defaultLinked
                ? linkedRunning
                  ? `停止「${defaultLinked.name}」`
                  : `启动「${defaultLinked.name}」`
                : '关联启动'
            }
            onPointerDown={linkedLongPress.onPointerDown}
            onClick={(e) => linkedClick(e.currentTarget)}
          >
            <Icon name="link" size={16} />
            <ScrollText text={linkedLabel} maxWidth={96} />
          </button>
        </HomeModule>
      )}

      {launch.visible && (
        <HomeModule
          moduleId="launch"
          state={launch}
          stageRef={stageRef}
          anchor={{ right: 26, bottom: 26 }}
          live={live.launch ?? null}
          shift={shifts.launch ?? null}
          dragging={dragId === 'launch'}
          dragEnabled={!picker}
          raised={picker?.kind === 'launch'}
          override={override.launch ?? null}
          register={register}
          onDrag={onDragModule}
          onDrop={onDropModule}
          onMeasure={(w) => setLaunchW((prev) => (Math.abs(prev - w) > 1 ? w : prev))}
        >
          <DownloadButton
            label={<ScrollText text={launchLabel} maxWidth={150} />}
            tone={launchTone}
            progress={launchProgress}
            paused={paused}
            ringTone={launchRing}
            idleIcon={launchIcon}
            selected={picker?.kind === 'launch' && pickHighlight === 'default'}
            onButtonClick={launchButtonClick}
            popup={popup}
            boundsRef={stageRef}
            onLongPress={
              methodPickerEnabled && !picker
                ? (rect) => openPicker('launch', rect)
                : undefined
            }
          />
        </HomeModule>
      )}

      {picker && drawerOptions.length > 0 && (
        <LaunchDrawer
          anchor={picker.anchor}
          bounds={boundsRect}
          radius={Math.round(picker.anchor.height / 2)}
          options={drawerOptions}
          onHighlight={setPickHighlight}
          onPick={pickChoice}
          onClose={closePicker}
          closing={pickerClosing}
        />
      )}
    </div>
  )
}
