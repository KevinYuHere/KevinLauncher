import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react'
import {
  normalizeKevinHudConfig,
  usesKevinHudMemoryReadout,
  type KevinHudFrame,
  type KevinHudMetric
} from '@shared/kevinHud'
import type { LauncherFontSource } from '@shared/launcherFonts'
import { parseKevinHudMemoryDisplay } from '@shared/kevinHudMemory'
import {
  KEVIN_HUD_ANNOUNCE_STATUS_TEXT,
  kevinHudSizingKey
} from '@shared/kevinHudSizing'
import { applyLauncherTypography } from '../launcherTypography'
import KevinHudMemoryReadout from './KevinHudMemoryReadout'
import {
  formatKevinHudValue,
  kevinHudAppName,
  kevinHudItemAlignment,
  kevinHudMetricAriaLabel,
  kevinHudMetricLabel,
  kevinHudPlacement,
  kevinHudRevealOrigin,
  kevinHudTitleOrigins,
  layoutKevinHudRows,
  orderKevinHudMetrics,
  resolveKevinHudItemVisual,
  resolveKevinHudVisual,
  type KevinHudCssVars
} from './kevinHudVisual'
import '../assets/kevinHudOverlay.css'

/**
 * Narrow contract exposed by `src/preload/kevinHud.ts`. Kept structural so the
 * renderer can be mounted on its own (tests / a dedicated HUD window) without
 * importing a preload module that needs Electron's isolated world.
 */
export interface KevinHudFrameBridge {
  onFrame(listener: (frame: KevinHudFrame) => void): () => void
  /**
   * Pull the latest cached frame. The owner should also re-send its cache after
   * the HUD page loads; that repeated send covers a frame produced before the
   * renderer subscribed and makes this optional pull a recovery path.
   */
  ready?(handshake?: { token?: string }): Promise<KevinHudFrame | null>
}

export interface KevinHudOverlayProps {
  /**
   * Controlled frame. Leave undefined to let the overlay consume frames from
   * `window.kevinHud`. Pass null to explicitly render nothing.
   */
  frame?: KevinHudFrame | null
  /** Override (or disable, with null) the auto-detected preload bridge. */
  bridge?: KevinHudFrameBridge | null
  /**
   * Optional owner-defined handshake material. The overlay forwards it to the
   * preload's recovery pull; the HUD window owner remains responsible for
   * authenticating the sender.
   */
  readyToken?: string
  className?: string
}

type HudStyle = CSSProperties & KevinHudCssVars & Record<string, string | number | undefined>
type VisiblePhase = 'announce' | 'monitor'
type MotionMode = 'enter' | 'exit'
type ExitMode = 'clock' | 'restart' | 'reduced' | null
type OverflowState = { overflow: boolean; distance: number }

// Exact entrance names only. In particular, the overflow marquee
// (`kevin-hud-scroll`) must keep running (or CSS-pause) independently of the
// reversible entrance clock.
const ENTRANCE_ANIMATION_NAMES = new Set([
  'kevin-hud-plate',
  'kevin-hud-icon',
  'kevin-hud-title',
  'kevin-hud-reveal',
  'kevin-hud-ripple'
])

const isFrame = (value: unknown): value is KevinHudFrame => {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<KevinHudFrame>
  return (
    (candidate.phase === 'announce' ||
      candidate.phase === 'monitor' ||
      candidate.phase === 'exit') &&
    candidate.config !== null &&
    typeof candidate.config === 'object'
  )
}

const isPhase = (value: unknown): value is KevinHudFrame['phase'] =>
  value === 'announce' || value === 'monitor' || value === 'exit'

const detectBridge = (): KevinHudFrameBridge | null => {
  if (typeof window === 'undefined') return null
  const candidate = (window as Window & { kevinHud?: unknown }).kevinHud
  if (candidate === null || typeof candidate !== 'object') return null
  const bridge = candidate as Partial<KevinHudFrameBridge>
  return typeof bridge.onFrame === 'function' ? (bridge as KevinHudFrameBridge) : null
}

/**
 * `KevinHudWindow` creates a transparent window that is already exactly the
 * configured pill (the main process owns x/y/anchor and monitor placement) and
 * tags its document with `?kevinHud=1`. In that host the overlay fills the
 * window instead of applying screen percentages a second time. Other mounts
 * (preview/embedding) keep the standalone viewport positioning.
 */
const isDedicatedHudWindow = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).get('kevinHud') === '1'
  } catch {
    return false
  }
}

const prefersReducedMotion = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/**
 * Read an element's settled layout offset inside the HUD surface. `offsetLeft`
 * and `offsetWidth` ignore CSS transforms, so an entrance/reverse animation
 * cannot corrupt the measured anchor origin.
 */
function measureOffsetWithin(
  element: HTMLElement,
  surface: HTMLElement
): { left: number; width: number } {
  let node: HTMLElement | null = element
  let left = 0
  while (node && node !== surface) {
    left += node.offsetLeft
    node = node.offsetParent as HTMLElement | null
  }
  if (node === surface) return { left, width: element.offsetWidth }

  // A detached/odd offset chain falls back to painted geometry. This only
  // affects the live entrance pose, never the settled layout.
  const rect = element.getBoundingClientRect()
  const surfaceRect = surface.getBoundingClientRect()
  return { left: rect.left - surfaceRect.left, width: rect.width }
}

/** A quiet, independently drawn Kevin mark; never an app's real artwork. */
function KevinHudMark({ tint }: { tint: string | null }): ReactElement {
  return (
    <svg
      className="kevin-hud-icon-art kevin-hud-icon-mark"
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={tint ? { color: tint } : undefined}
    >
      <path d="M5.4 4.5v15" stroke="currentColor" strokeWidth="2.2" strokeLinecap="square" />
      <path d="M6.2 12 13.3 4.5M6.2 12l7.1 7.5" stroke="currentColor" strokeWidth="2.2" />
      <path d="m16.2 8.4 4 3.6-4 3.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

function KevinHudIcon({
  iconUrl,
  tint
}: {
  iconUrl: string | null
  tint: string | null
}): ReactElement {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const rawId = useId()
  const filterId = `kevin-hud-tint-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`

  if (!iconUrl || failedUrl === iconUrl) {
    return <KevinHudMark tint={tint} />
  }

  if (tint) {
    return (
      <svg className="kevin-hud-icon-art" viewBox="0 0 24 24" aria-hidden="true">
        <defs>
          <filter
            id={filterId}
            x="-20%"
            y="-20%"
            width="140%"
            height="140%"
            colorInterpolationFilters="sRGB"
          >
            <feFlood floodColor={tint} result="tint" />
            <feComposite in="tint" in2="SourceAlpha" operator="in" />
          </filter>
        </defs>
        <image
          href={iconUrl}
          x="0"
          y="0"
          width="24"
          height="24"
          preserveAspectRatio="xMidYMid meet"
          filter={`url(#${filterId})`}
          onError={() => setFailedUrl(iconUrl)}
        />
      </svg>
    )
  }

  return (
    <img
      className="kevin-hud-icon-art"
      src={iconUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      onError={() => setFailedUrl(iconUrl)}
    />
  )
}

/** Small, non-textual confirmation that this is a launch surface. */
function KevinHudLaunchSign(): ReactElement {
  return (
    <svg
      className="kevin-hud-launch-sign"
      viewBox="0 0 8 10"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M1.2 1.2 6.9 5l-5.7 3.8Z" fill="currentColor" />
    </svg>
  )
}

/**
 * Compact description glyphs for the optional `description: 'icon'` item
 * format. They are small independent line drawings (no icon font, sprite or
 * upstream asset) and inherit the HUD's current text colour.
 */
function KevinHudMetricGlyph({ metric }: { metric: KevinHudMetric }): ReactElement {
  let shape: ReactElement
  switch (metric) {
    case 'sessionTime':
    case 'totalTime':
      shape = (
        <>
          <circle cx="12" cy="12" r="7.2" />
          <path d="M12 8.1v4.2l2.6 1.7M9 4.2h6" />
        </>
      )
      break
    case 'fps':
      shape = <path d="M3 14h4l2-6 3 10 2.4-6H21" />
      break
    case 'gpu':
    case 'cpu':
      shape = (
        <>
          <rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2" />
          <path d="M9.5 9.6h5v5h-5zM9 3.6v2.8M15 3.6v2.8M9 17.6v2.8M15 17.6v2.8M3.6 9h2.8M3.6 15h2.8M17.6 9h2.8M17.6 15h2.8" />
        </>
      )
      break
    case 'memory':
      shape = (
        <>
          <rect x="4.5" y="7" width="15" height="10" rx="2" />
          <path d="M8 10.2h8M8 13.8h5.5M7 4.5v2.5M12 4.5v2.5M17 4.5v2.5M7 17v2.5M12 17v2.5M17 17v2.5" />
        </>
      )
      break
    case 'download':
      shape = (
        <>
          <path d="M12 3.8v10.4M7.8 10.2 12 14.4l4.2-4.2M4.5 18.8h15" />
        </>
      )
      break
    case 'upload':
      shape = (
        <>
          <path d="M12 20.2V9.8M7.8 13.8 12 9.6l4.2 4.2M4.5 5.2h15" />
        </>
      )
      break
    case 'clock':
      shape = (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 7.2V12l3.1 2.1" />
        </>
      )
      break
    default:
      shape = <circle cx="12" cy="12" r="5" />
  }
  return (
    <svg
      className="kevin-hud-metric-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shape}
    </svg>
  )
}

/**
 * A compact, read-only HUD surface.
 *
 * The component derives its appearance from the supplied frame. It does not
 * poll, observe the page, sample a metric or paint a permanent pattern. The
 * dedicated native host is the settled height in every phase (the configured
 * lower bound raised when an item descriptor needs more room); the finite
 * entrance only grows from a shorter pose into that exact host height, and the
 * exit runs the same CSS timeline backwards on the same elements. Ordinary
 * value/config updates only change local custom properties, so they cannot
 * restart it.
 */
export function KevinHudOverlay({
  frame: controlledFrame,
  bridge: bridgeOverride,
  readyToken,
  className
}: KevinHudOverlayProps = {}): ReactElement | null {
  const [bridgedFrame, setBridgedFrame] = useState<KevinHudFrame | null>(null)
  const isControlled = controlledFrame !== undefined
  const frame = isControlled ? controlledFrame : bridgedFrame
  const hostFillsWindow = isDedicatedHudWindow()
  const hostMode = hostFillsWindow ? 'window' : 'viewport'

  const lastVisiblePhase = useRef<VisiblePhase>('monitor')
  const phaseRef = useRef<KevinHudFrame['phase'] | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const bankRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)

  // Fresh documents keep this at zero; a later announcement in the same
  // recycled preview document increments it so a new entrance may mount.
  const [entryEpoch, setEntryEpoch] = useState(0)
  const [motionMode, setMotionMode] = useState<MotionMode>('enter')
  const [exitClock, setExitClock] = useState(false)
  const [exitMode, setExitMode] = useState<ExitMode>(null)
  const [overflow, setOverflow] = useState<OverflowState>({ overflow: false, distance: 0 })

  useEffect(() => {
    if (isControlled) return undefined
    const bridge = bridgeOverride === undefined ? detectBridge() : bridgeOverride
    if (!bridge) return undefined

    let alive = true
    let receivedPush = false
    let unsubscribe: (() => void) | undefined

    const acceptPush = (candidate: unknown): void => {
      if (!alive || !isFrame(candidate)) return
      receivedPush = true
      setBridgedFrame(candidate)
    }

    try {
      const stop = bridge.onFrame(acceptPush)
      if (typeof stop === 'function') unsubscribe = stop
    } catch {
      // A missing subscription must not prevent the first-frame recovery pull.
    }

    const ready = bridge.ready
    if (typeof ready === 'function') {
      void Promise.resolve()
        .then(() => ready.call(bridge, readyToken ? { token: readyToken } : undefined))
        .then((first) => {
          // A push that arrived while the handshake was in flight is fresher.
          if (!alive || receivedPush || !isFrame(first)) return
          setBridgedFrame(first)
        })
        .catch(() => {
          // No handler yet simply means the owner has not wired the handshake;
          // the repeated cached push remains the fallback.
        })
    }

    return () => {
      alive = false
      unsubscribe?.()
    }
  }, [bridgeOverride, isControlled, readyToken])

  const config = useMemo(
    () => (frame ? normalizeKevinHudConfig(frame.config) : null),
    [frame?.config]
  )
  const phase = frame && isPhase(frame.phase) ? frame.phase : null
  if (phase === 'announce' || phase === 'monitor') lastVisiblePhase.current = phase
  const exitFrom = phase === 'exit' ? lastVisiblePhase.current : null
  const visual = useMemo(
    () =>
      config
        ? resolveKevinHudVisual(config, frame?.appGlass ?? null, {
            phase: phase ?? 'monitor',
            host: hostMode,
            exitFrom
          })
        : null,
    [config, frame?.appGlass, phase, hostMode, exitFrom]
  )
  const metrics = useMemo(() => orderKevinHudMetrics(config?.metrics), [config])
  const metricKey = metrics.join(',')
  const announcement = phase === 'announce' || (phase === 'exit' && exitFrom === 'announce')
  // Announcements always force icon + name. A settled monitor keeps every
  // selected metric, including icon/name, in the one measured track.
  const identityOnly = announcement
  const showBank = !identityOnly && metrics.length > 0
  // The dedicated memory readout is only for a config that selects memory and
  // nothing else. App icon/name plus memory is an ordinary multi-item row.
  const memoryOnly = showBank && metrics.length === 1 && metrics[0] === 'memory'
  const layout = useMemo(
    () => layoutKevinHudRows(metrics, config?.autoWidth ?? false),
    [metrics, config?.autoWidth]
  )
  const sizingKey = useMemo(
    () => kevinHudSizingKey(config),
    [config]
  )
  // The preset is top-centre; it owns the alignment even when a manual anchor
  // remains stored from a previous custom placement.
  const effectiveAnchor =
    config?.positionMode === 'preset' ? 'center' : (config?.anchor ?? 'center')

  const appName = frame ? kevinHudAppName(frame.appName) : 'KEVIN'
  const values = frame?.values ?? {}
  const memoryDisplay =
    metrics.includes('memory') ? parseKevinHudMemoryDisplay(values.memory) : null
  const memory = memoryOnly ? memoryDisplay : null
  const memoryUnit = memory?.unit ?? 'GB'

  const fontFamily = frame?.fontFamily ?? null
  const fontFamilyEn = frame?.fontFamilyEn
  const fontFamilyZh = frame?.fontFamilyZh

  // The dedicated HUD document applies the launcher's independent per-script
  // fonts through the same helper as the launcher. CSS only reads --app-font;
  // there is no inline legacy font-stack override left in this component.
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return
    const source: LauncherFontSource = { fontFamily }
    if (fontFamilyEn !== undefined) source.fontFamilyEn = fontFamilyEn
    if (fontFamilyZh !== undefined) source.fontFamilyZh = fontFamilyZh
    applyLauncherTypography(document, source)
  }, [fontFamily, fontFamilyEn, fontFamilyZh])

  // Phase transitions are decided before paint so a transient announcement
  // that is closed mid-flight reverses its existing CSS animations in place
  // instead of remounting/resetting them. A settled exit uses fresh reverse
  // aliases on the same DOM nodes, preserving their identity.
  useLayoutEffect(() => {
    if (!phase) {
      phaseRef.current = null
      setMotionMode('enter')
      setExitClock(false)
      setExitMode(null)
      return
    }

    const previous = phaseRef.current
    phaseRef.current = phase

    if (phase === 'exit') {
      if (previous === 'exit') return
      if (prefersReducedMotion()) {
        setExitClock(false)
        setExitMode('reduced')
        return
      }
      const surface = surfaceRef.current

      // A transient close keeps the entrance alive and flips the real Web
      // Animations playback clock. `reverse()` preserves each animation's
      // current time, so a close at progress p continues from p rather than
      // seeking to 1 - p. CSS must keep `animation-direction: normal` here;
      // its own reverse would double-invert this negative playbackRate.
      // Snapshot all entrance CSSAnimations once: surface + descendants, exact
      // entrance names only, so the overflow marquee is never reversed.
      let reversed = false
      if (surface) {
        try {
          const animations = surface.getAnimations({ subtree: true })
          const entrances =
            typeof CSSAnimation === 'undefined'
              ? []
              : animations.filter(
                  (animation): animation is CSSAnimation =>
                    animation instanceof CSSAnimation &&
                    ENTRANCE_ANIMATION_NAMES.has(animation.animationName)
                )
          if (entrances.some((animation) => animation.playState === 'running')) {
            for (const animation of entrances) animation.reverse()
            reversed = true
          }
        } catch {
          reversed = false
        }
      }

      if (reversed) {
        setExitClock(true)
        setExitMode('clock')
      } else {
        // No reversible Web Animations clock: fall back to the fresh reverse
        // aliases instead of leaving the entrance running through the exit.
        setExitClock(false)
        setExitMode('restart')
        setMotionMode('exit')
      }
      return
    }

    if (previous === 'exit' || previous === null) {
      if (previous === 'exit') setEntryEpoch((value) => value + 1)
      setMotionMode('enter')
      setExitClock(false)
      setExitMode(null)
    }
  }, [phase])

  // Measure the settled geometry once per layout/open, never on a value sample.
  // Each visible item receives one bounded signed origin and stagger; the
  // reverse exit reuses the exact same values on the exact same elements.
  const revealKey = [
    effectiveAnchor,
    config?.direction ?? '',
    config?.width ?? 0,
    config?.height ?? 0,
    showBank ? 1 : 0,
    announcement ? 1 : 0,
    metricKey,
    sizingKey,
    appName,
    phase === 'announce' ? 'a' : phase === 'exit' ? 'x' : 'b',
    entryEpoch
  ].join('|')

  useLayoutEffect(() => {
    const surface = surfaceRef.current
    if (!surface || !config || !phase || phase === 'exit') return

    const surfaceWidth = surface.offsetWidth
    if (!Number.isFinite(surfaceWidth) || surfaceWidth <= 0) return

    const identityElement = surface.querySelector<HTMLElement>(
      '.kevin-hud-identity[data-khud-reveal="identity"]'
    )
    const itemElements = Array.from(
      surface.querySelectorAll<HTMLElement>('[data-khud-reveal="item"]')
    )
    const count = itemElements.length

    if (identityElement) {
      const measured = measureOffsetWithin(identityElement, surface)
      // The announcement identity block uses absolute children, so a very
      // narrow/empty layout box falls back to a calm leading-block estimate.
      const width = measured.width > 8 ? measured.width : Math.min(360, surfaceWidth * 0.45)
      const centerX = measured.width > 8 ? measured.left + width / 2 : width / 2
      const origin = kevinHudRevealOrigin({
        anchor: effectiveAnchor,
        direction: config.direction,
        centerX,
        surfaceWidth,
        index: 0,
        count,
        leading: true
      })
      identityElement.style.setProperty('--khud-origin-x', `${origin.x}px`)
      identityElement.style.setProperty('--khud-origin-y', `${origin.y}px`)
      identityElement.style.setProperty('--khud-reveal-delay', `${origin.delayMs}ms`)
      identityElement.style.setProperty(
        '--khud-reveal-exit-delay',
        `${origin.exitDelayMs}ms`
      )

      // The title wrapper stays still; each label owns its own signed origin so
      // a centred name can glide left while the status glides right. Measurement
      // uses settled layout offsets, so a running entrance cannot feed back into
      // the values and the reverse reuses the same trajectories.
      const titleBlock = identityElement.querySelector<HTMLElement>(
        '.kevin-hud-title-block'
      )
      const launching = identityElement.querySelector<HTMLElement>(
        '.kevin-hud-launching'
      )
      if (titleBlock && launching) {
        const nameMeasured = measureOffsetWithin(titleBlock, surface)
        const statusMeasured = measureOffsetWithin(launching, surface)
        const titleOrigins = kevinHudTitleOrigins({
          anchor: effectiveAnchor,
          direction: config.direction,
          surfaceWidth,
          nameCenterX: nameMeasured.left + Math.max(8, nameMeasured.width) / 2,
          statusCenterX: statusMeasured.left + Math.max(8, statusMeasured.width) / 2
        })
        titleBlock.style.setProperty(
          '--khud-title-origin-x',
          `${titleOrigins.name.x}px`
        )
        titleBlock.style.setProperty(
          '--khud-title-origin-y',
          `${titleOrigins.name.y}px`
        )
        launching.style.setProperty(
          '--khud-title-origin-x',
          `${titleOrigins.status.x}px`
        )
        launching.style.setProperty(
          '--khud-title-origin-y',
          `${titleOrigins.status.y}px`
        )
      }
    }

    itemElements.forEach((element, index) => {
      const measured = measureOffsetWithin(element, surface)
      const width = Math.max(8, measured.width)
      const origin = kevinHudRevealOrigin({
        anchor: effectiveAnchor,
        direction: config.direction,
        centerX: measured.left + width / 2,
        surfaceWidth,
        index,
        count
      })
      element.style.setProperty('--khud-origin-x', `${origin.x}px`)
      element.style.setProperty('--khud-origin-y', `${origin.y}px`)
      element.style.setProperty('--khud-reveal-delay', `${origin.delayMs}ms`)
      element.style.setProperty(
        '--khud-reveal-exit-delay',
        `${origin.exitDelayMs}ms`
      )
    })
  }, [revealKey])

  // Detect real overflow at layout and whenever a layout input changes: the
  // configuration, the selected launcher font, or the host/content size. The
  // animation itself is pure CSS; ordinary samples do not recreate the track or
  // restart a running scroll.
  useLayoutEffect(() => {
    if (!showBank) {
      setOverflow((previous) =>
        previous.overflow ? { overflow: false, distance: 0 } : previous
      )
      return undefined
    }
    const bank = bankRef.current
    const track = trackRef.current
    if (!bank || !track) return undefined

    let disposed = false
    const measure = (): void => {
      if (disposed) return
      const available = bank.clientWidth
      // Measure layout extents, not painted/scroll extents: `scrollWidth`
      // includes each cell's transient reveal translation and can report a
      // permanent overflow after the animation has already returned home.
      // The track is position:relative, so direct-child offsetLeft/offsetWidth
      // give untransformed cell edges relative to its content box.
      let content = track.clientWidth
      for (const child of Array.from(track.children)) {
        const cell = child as HTMLElement
        content = Math.max(content, cell.offsetLeft + cell.offsetWidth)
      }
      const distance = Math.max(0, Math.ceil(content - available))
      const nextOverflow = distance > 1
      setOverflow((previous) => {
        if (
          previous.overflow === nextOverflow &&
          Math.abs(previous.distance - distance) <= 1
        ) {
          return previous
        }
        return nextOverflow
          ? { overflow: true, distance }
          : { overflow: false, distance: 0 }
      })
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(bank)
    observer.observe(track)
    for (const child of Array.from(track.children)) observer.observe(child)

    // Deliberately no MutationObserver on the sampled text: a normal value
    // update must never trigger a re-measure/reflow. The shared sizing helper
    // already reserves the widest legal value format, each cell has that
    // stable min-width, and ResizeObserver only reacts when layout actually
    // changes (config, font loading or host size).

    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [
    showBank,
    memoryOnly,
    metricKey,
    sizingKey,
    entryEpoch,
    appName,
    fontFamily,
    fontFamilyEn,
    fontFamilyZh
  ])

  if (!frame || !config || !visual || !phase || !config.enabled) return null

  const placement = hostFillsWindow
    ? undefined
    : kevinHudPlacement(effectiveAnchor, config.x, config.y)
  const iconUrl =
    typeof frame.iconUrl === 'string' && frame.iconUrl.trim() ? frame.iconUrl.trim() : null
  const compact =
    (Number.parseFloat(visual.vars['--khud-content-min-height']) ||
      Number.parseFloat(visual.vars['--khud-height']) ||
      config.height) < 36
  // The dedicated BrowserWindow is the settled plate. The main process may
  // raise its height above the configured lower bound for a vertical/large
  // descriptor; fill that host exactly. Standalone previews keep the resolved
  // design height.
  const surfaceStyle: HudStyle = hostFillsWindow
    ? { ...visual.vars, '--khud-plate-height': '100%' }
    : visual.vars
  const overflowDuration = Math.min(
    20_000,
    Math.max(7_000, Math.round(overflow.distance * 36))
  )
  const bankStyle: HudStyle = overflow.overflow
    ? {
        '--khud-overflow-distance': `${overflow.distance}px`,
        '--khud-overflow-duration': `${overflowDuration}ms`
      }
    : {}
  const memoryHasAmounts = Boolean(memory?.used && memory?.total)
  const memoryAria = memory
    ? `内存使用：已用 ${memory.used ?? '--'} ${memoryUnit}，总量 ${
        memory.total ?? '--'
      } ${memoryUnit}，占用 ${memory.percent}`
    : '内存使用：不可用'
  const memoryItemVisual = resolveKevinHudItemVisual(config, 'memory', appName)
  // The dedicated capsule is drawn around the app-wide descriptor. The new
  // reference default is the memory chip glyph; a user who chooses the text
  // descriptor for every item still gets the compact `MEM` eyebrow here.
  const memoryDescription = memoryItemVisual.style.description
  const memoryReadoutStyle = {
    ...memoryItemVisual.style,
    description: memoryDescription
  }
  const memoryStyle: HudStyle = { ...memoryItemVisual.vars }
  const memoryAlignment = kevinHudItemAlignment(memoryItemVisual.style)
  // The gauge composition is the untouched reference default. Any customized
  // alignment reuses the ordinary item cell instead, keeping the full
  // used/total/unit/percentage text and the same alignment rules as every other
  // item. minWidth and gap still apply in both branches.
  const memoryUsesGauge =
    memoryOnly && usesKevinHudMemoryReadout(memoryItemVisual.style)

  const renderMetricCell = (
    metric: KevinHudMetric,
    options: { fullMemory?: boolean } = {}
  ): ReactElement => {
    const item = resolveKevinHudItemVisual(config, metric, appName)
    const alignment = kevinHudItemAlignment(item.style)

    if (metric === 'appName') {
      // The monitored identity is an ordinary row item now: the description is
      // the actual app icon (or the existing fallback) and the value is the
      // real app name. The name ignores sampled `values.appName`, follows the
      // app-wide orientation/type controls, and may use the appName-specific
      // gap/description/value colours. The icon keeps its original colours when
      // no tint is configured.
      const aria = `${kevinHudMetricAriaLabel(metric)}：${appName}`
      return (
        <div
          key={metric}
          className="kevin-hud-cell kevin-hud-metric"
          data-cell={metric}
          data-khud-reveal="item"
          data-orientation={item.style.orientation}
          data-description="icon"
          data-description-bold={item.style.descriptionBold ? 'true' : 'false'}
          data-value-bold={item.style.valueBold ? 'true' : 'false'}
          data-align-mode={alignment.mode}
          data-align-center={alignment.center ?? undefined}
          data-align-reverse={alignment.reverse ? 'true' : undefined}
          data-description-align={alignment.description}
          data-value-align={alignment.value}
          data-unavailable="false"
          role="listitem"
          aria-label={aria}
          style={item.vars}
        >
          <span className="kevin-hud-copy">
            <span
              className="kevin-hud-metric-description kevin-hud-metric-description--icon"
              data-align={alignment.description}
              aria-hidden="true"
            >
              <span className="kevin-hud-metric-app-icon">
                {/*
                  The appName description colour is the per-item tint when it
                  is set; otherwise the HUD-wide icon colour still applies, and
                  with neither the real icon keeps its original colours.
                */}
                <KevinHudIcon
                  iconUrl={iconUrl}
                  tint={item.style.descriptionColor ?? visual.iconTint}
                />
              </span>
            </span>
            <span
              className="kevin-hud-metric-value"
              data-align={alignment.value}
            >
              {appName}
            </span>
          </span>
        </div>
      )
    }

    // A multi-item memory cell shows the compact percentage parsed by the
    // shared helper. When a customised memory-only layout reuses this ordinary
    // cell, the full used/total/unit readout is kept instead; only the gauge
    // composition is replaced, never the measured data.
    const value =
      metric === 'memory'
        ? options.fullMemory
          ? memoryDisplay
            ? { text: memoryDisplay.text, unavailable: false }
            : { text: '--', unavailable: true }
          : memoryDisplay
            ? { text: memoryDisplay.percent, unavailable: false }
            : { text: '--', unavailable: true }
        : formatKevinHudValue(values[metric])
    const description = item.style.description
    const aria = kevinHudMetricAriaLabel(metric)
    const ariaValue = value.unavailable ? `${aria}：不可用` : `${aria}：${value.text}`
    return (
      <div
        key={metric}
        className="kevin-hud-cell kevin-hud-metric"
        data-cell={metric}
        data-khud-reveal="item"
        data-orientation={item.style.orientation}
        data-description={description}
        data-description-bold={item.style.descriptionBold ? 'true' : 'false'}
        data-value-bold={item.style.valueBold ? 'true' : 'false'}
        data-memory-full={
          metric === 'memory' && options.fullMemory ? 'true' : undefined
        }
        data-align-mode={alignment.mode}
        data-align-center={alignment.center ?? undefined}
        data-align-reverse={alignment.reverse ? 'true' : undefined}
        data-description-align={alignment.description}
        data-value-align={alignment.value}
        data-unavailable={value.unavailable ? 'true' : 'false'}
        role="listitem"
        aria-label={ariaValue}
        style={item.vars}
      >
        <span className="kevin-hud-copy">
          <span
            className={`kevin-hud-metric-description kevin-hud-metric-description--${description}`}
            data-align={alignment.description}
            aria-hidden="true"
          >
            {description === 'icon' ? (
              <KevinHudMetricGlyph metric={metric} />
            ) : (
              <span className="kevin-hud-metric-label">
                {kevinHudMetricLabel(metric)}
              </span>
            )}
          </span>
          <span
            className="kevin-hud-metric-value"
            data-align={alignment.value}
          >
            {value.text}
          </span>
        </span>
      </div>
    )
  }

  // Announcements (and their reverse) keep the staged icon + name identity.
  // The settled monitor never renders this block: selected identity metrics
  // join the measured track above in their configured order.
  const identityBlock = announcement ? (
    <div
      className="kevin-hud-identity"
      data-icon="true"
      data-name="true"
      data-launching="true"
      data-khud-reveal="identity"
    >
      {/*
        Visual order is triangle -> circular app icon -> app name. The marker
        lives inside the icon's motion wrapper, so the icon's entrance glide
        carries both shapes as one mark. The status label stays at the trailing
        edge and shares the title's entrance/exit fade.
      */}
      <span className="kevin-hud-icon-motion" aria-hidden="true">
        <KevinHudLaunchSign />
        <span className="kevin-hud-icon-cell" data-cell="appIcon">
          <span className="kevin-hud-icon-frame">
            <KevinHudIcon iconUrl={iconUrl} tint={visual.iconTint} />
          </span>
        </span>
      </span>
      <span className="kevin-hud-title-motion">
        <span className="kevin-hud-title-block">
          <span className="kevin-hud-app-name">{appName}</span>
        </span>
        <span className="kevin-hud-launching">
          {KEVIN_HUD_ANNOUNCE_STATUS_TEXT}
        </span>
      </span>
    </div>
  ) : null

  const memoryBlock = (
    <div
      className="kevin-hud-memory"
      data-khud-reveal="item"
      data-memory-amounts={memoryHasAmounts ? 'true' : 'false'}
      data-memory-percent={memory?.percent ?? ''}
      data-orientation={memoryReadoutStyle.orientation}
      data-description={memoryReadoutStyle.description}
      data-align-mode={memoryAlignment.mode}
      data-align-center={memoryAlignment.center ?? undefined}
      data-align-reverse={memoryAlignment.reverse ? 'true' : undefined}
      data-description-align={memoryAlignment.description}
      data-value-align={memoryAlignment.value}
      data-memory-mode="gauge"
      role="img"
      aria-label={memoryAria}
      style={memoryStyle}
    >
      <span className="kevin-hud-memory-visual" aria-hidden="true">
        <KevinHudMemoryReadout
          used={memory?.used ?? null}
          total={memory?.total ?? null}
          percent={memory?.percentValue ?? null}
          unit={memoryUnit}
          itemStyle={memoryReadoutStyle}
          descriptionLabel={kevinHudMetricLabel('memory')}
        />
      </span>
    </div>
  )

  return (
    <div
      className={`kevin-hud-root${className ? ` ${className}` : ''}`}
      data-phase={phase}
      data-direction={config.direction}
      data-anchor={effectiveAnchor}
      data-host={hostMode}
      aria-hidden={phase === 'exit' ? true : undefined}
    >
      <div className="kevin-hud-anchor" style={placement}>
        <div
          key={`hud-session-${entryEpoch}`}
          ref={surfaceRef}
          className="kevin-hud-surface"
          style={surfaceStyle}
          data-background={config.backgroundMode}
          data-material={visual.material}
          data-gradient-kind={visual.gradient?.kind}
          data-gradient-angle={visual.gradient?.angle}
          data-auto-width={config.autoWidth ? 'true' : 'false'}
          data-monitor={config.monitor}
          data-layout={layout.layout}
          data-compact={compact ? 'true' : undefined}
          data-phase={phase}
          data-exit-from={exitFrom ?? undefined}
          data-motion={motionMode}
          data-exit-clock={exitClock ? 'true' : undefined}
          data-exit-mode={exitMode ?? undefined}
          role="group"
          aria-label={
            announcement || metrics.includes('appName')
              ? `KEVIN HUD，${appName}`
              : 'KEVIN HUD'
          }
          aria-live="off"
        >
          <div className="kevin-hud-background" aria-hidden="true">
            <span className="kevin-hud-fill" />
            <span className="kevin-hud-material" />
          </div>

          <div className="kevin-hud-foreground">
            <div
              className="kevin-hud-content"
              data-bank={showBank ? 'true' : 'false'}
              data-identity-only={identityOnly ? 'true' : undefined}
              data-memory-only={memoryUsesGauge ? 'true' : undefined}
              data-memory-mode={
                memoryOnly ? (memoryUsesGauge ? 'gauge' : 'aligned') : undefined
              }
            >
              {identityBlock}

              {showBank ? (
                <div
                  ref={bankRef}
                  className="kevin-hud-bank"
                  data-layout={layout.layout}
                  data-mode={memoryOnly ? 'memory' : 'metrics'}
                  data-overflow={overflow.overflow ? 'true' : 'false'}
                  data-auto-width-fallback={
                    config.autoWidth && overflow.overflow ? 'true' : undefined
                  }
                  style={bankStyle}
                  role={memoryUsesGauge ? 'group' : 'list'}
                  aria-label={memoryOnly ? '内存使用' : '运行指标'}
                >
                  <div ref={trackRef} className="kevin-hud-track">
                    {memoryOnly
                      ? memoryUsesGauge
                        ? memoryBlock
                        : renderMetricCell('memory', { fullMemory: true })
                      : (layout.rows[0] ?? []).map((metric) => renderMetricCell(metric))}
                  </div>
                </div>
              ) : null}
            </div>

            <span className="kevin-hud-ripple" aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  )
}

export default KevinHudOverlay
