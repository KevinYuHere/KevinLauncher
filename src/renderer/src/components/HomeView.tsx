import {
  useEffect,
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
  type UpdateInfo,
  type UpdateStatus
} from '@shared/types'
import { useJellyDrag } from '../drag/useJellyDrag'
import { pushOut2D, type Rect } from '../drag/resolve'
import { showToast } from './toast'
import DownloadButton, { type DownloadTone, type RingTone } from './DownloadButton'
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
  onLaunch: () => void
  onStop: () => void
  onUpdateToggle: () => void
  onPreDownloadToggle: () => void
  onShowStats: () => void
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
    enabled: state.draggable,
    mode: 'position',
    popScale: 1.2,
    maxStretch: 0.46,
    onDrag: (dx, dy) => onDrag(moduleId, dx, dy),
    onDrop: (dx, dy) => onDrop(moduleId, dx, dy)
  })

  return (
    <div
      ref={wrapRef}
      className={`home-module${state.draggable ? ' draggable' : ''}${dragging ? ' dragging' : ''}`}
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

export default function HomeView({
  entry,
  addon,
  running,
  startedAt,
  totalSec,
  updateInfo,
  updateStatus,
  onLaunch,
  onStop,
  onUpdateToggle,
  onPreDownloadToggle,
  onShowStats,
  onMoveModule,
  onModuleUnplaceable
}: HomeViewProps): ReactElement {
  const [now, setNow] = useState(Date.now())
  const [launchW, setLaunchW] = useState(0)
  const [live, setLive] = useState<Record<string, { x: number; y: number }>>({})
  const [shifts, setShifts] = useState<Record<string, { x: number; y: number }>>({})
  const [override, setOverride] = useState<Record<string, { left: number; top: number }>>({})
  const [dragId, setDragId] = useState<HomeModuleId | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
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

  const visibleIds = (): HomeModuleId[] => HOME_MODULES.filter((m) => mod(m.id).visible).map((m) => m.id)

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
    // Live yield — shove the neighbours as we move, not only on release.
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
  // when an update / pre-download appears), not only on window resize.
  useEffect(() => {
    const ids: HomeModuleId[] = ['info', 'playtime', 'launch']
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
  }, [entry.id, entry.homeModules])

  // On enable: place the newly-visible module (push others aside, or report full).
  useEffect(() => {
    const sig = visibleIds().join(',')
    const prev = prevVisible.current
    prevVisible.current = sig
    if (!prev) return
    const newly = HOME_MODULES.map((m) => m.id).find(
      (id) => mod(id).visible && !prev.split(',').includes(id)
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
      setOverride((prev) => ({ ...prev, ...ov }))
      const list: { id: HomeModuleId; x: number; y: number }[] = [{ id: newly, x: r.x, y: r.y }]
      for (const [mid, pos] of moves) list.push({ id: mid as HomeModuleId, x: pos.x, y: pos.y })
      persist(list)
    }, 60)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.homeModules, entry.id])

  // Drop stale local overrides when the persisted state no longer matches it
  // (e.g. after "重置位置" sets x/y back to null, or after switching apps).
  useEffect(() => {
    setOverride((prev) => {
      let changed = false
      const next = { ...prev }
      for (const id of ['info', 'playtime', 'launch'] as HomeModuleId[]) {
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
  // fixed gap to its right.
  const launchIcon =
    !active && !paused && preAvailable ? <Icon name="update" size={16} /> : undefined
  let launchLabel = '启动'
  let launchTone: DownloadTone = 'plain'
  let launchProgress: number | null = null
  let launchRing: RingTone = 'pre'
  let launchClick = onLaunch
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

  return (
    <div className="home" ref={stageRef}>
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
          anchor={{ right: 26 + launchW + 12, bottom: 26 }}
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

      {launch.visible && (
        <HomeModule
          moduleId="launch"
          state={launch}
          stageRef={stageRef}
          anchor={{ right: 26, bottom: 26 }}
          live={live.launch ?? null}
          shift={shifts.launch ?? null}
          dragging={dragId === 'launch'}
          override={override.launch ?? null}
          register={register}
          onDrag={onDragModule}
          onDrop={onDropModule}
          onMeasure={(w) => setLaunchW((prev) => (Math.abs(prev - w) > 1 ? w : prev))}
        >
          <DownloadButton
            label={launchLabel}
            tone={launchTone}
            progress={launchProgress}
            paused={paused}
            ringTone={launchRing}
            idleIcon={launchIcon}
            onButtonClick={launchClick}
            popup={popup}
            boundsRef={stageRef}
          />
        </HomeModule>
      )}
    </div>
  )
}
