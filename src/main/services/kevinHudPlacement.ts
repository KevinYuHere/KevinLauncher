import { KEVIN_HUD_METRICS } from '@shared/kevinHud'
import type {
  KevinHudAnchor,
  KevinHudConfig,
  KevinHudFrame,
  KevinHudMetric,
  KevinHudMonitor
} from '@shared/kevinHud'
import {
  KEVIN_HUD_ANNOUNCE_STATUS_GAP,
  KEVIN_HUD_ANNOUNCE_STATUS_TEXT,
  KEVIN_HUD_DEFAULT_HEIGHT,
  KEVIN_HUD_DEFAULT_WIDTH,
  KEVIN_HUD_MAX_ALLOWED_WIDTH,
  KEVIN_HUD_MIN_ALLOWED_WIDTH,
  measureKevinHudAnnouncementWidth,
  measureKevinHudAnnounceStatusWidth,
  measureKevinHudItemWidth,
  measureKevinHudMinContentHeight,
  resolveKevinHudContentPadding,
  resolveKevinHudItemGap,
  resolveKevinHudWidthBounds,
  type KevinHudItemGeometry,
  type KevinHudSizingConfig,
  type KevinHudWidthBounds
} from '@shared/kevinHudSizing'

export {
  KEVIN_HUD_DEFAULT_HEIGHT,
  KEVIN_HUD_DEFAULT_WIDTH
} from '@shared/kevinHudSizing'

export type { KevinHudAnchor, KevinHudMonitor } from '@shared/kevinHud'

/**
 * Geometry and deterministic sizing for the KEVIN HUD.
 *
 * Everything in this module is pure and expressed in Electron DIPs. The window
 * service snapshots Electron displays (and, on Windows, their physical bounds)
 * and hands them in, so multi-monitor placement with negative origins and mixed
 * DPI can be tested without booting Electron.
 */

export interface KevinHudRect {
  x: number
  y: number
  width: number
  height: number
}

/** A screen rect in native physical pixels, e.g. a Win32 game-window rect. */
export type KevinHudPhysicalRect = KevinHudRect

/** A display snapshot; every rect except `physicalBounds` is in DIPs. */
export interface KevinHudDisplay {
  id: number
  bounds: KevinHudRect
  workArea: KevinHudRect
  scaleFactor: number
  /**
   * Native-pixel bounds of the display. Electron's `screen.dipToScreenRect`
   * supplies this on Windows; without it the DIP bounds are scaled by this
   * display's own factor (fine on a single-DPI desktop, approximate on mixed
   * DPI desktops).
   */
  physicalBounds?: KevinHudRect
}

/** The subset needed to map a physical rect into a display's DIP space. */
export interface KevinHudPhysicalDisplay {
  bounds: KevinHudRect
  scaleFactor: number
  physicalBounds?: KevinHudRect
}

/**
 * Which screen area the HUD belongs to.
 *
 * - `displayId` selects a display when no game-window rect is available.
 * - `gameWindowRect` is the game window in native physical pixels. The display
 *   it intersects most is selected (so negative origins and mixed DPI are
 *   handled), but the HUD's x/y percentages remain relative to that display's
 *   work area; the game window only chooses the screen.
 */
export interface KevinHudDisplayHint {
  displayId?: number | null
  gameWindowRect?: KevinHudPhysicalRect | null
}

/** How the HUD's saved x/y position is interpreted. */
export type KevinHudPositionMode = 'preset' | 'custom'

export interface KevinHudPlacementInput {
  displays: readonly KevinHudDisplay[]
  primaryDisplayId: number
  displayHint?: KevinHudDisplayHint | null
  monitor: KevinHudMonitor
  anchor: KevinHudAnchor
  /** Anchor point across the target area, 0..100. */
  x: number
  /** Top edge across the target area, 0..100. */
  y: number
  width: number
  height: number
  /**
   * Placement mode. Existing direct pure callers omit this and keep the
   * percentage/anchor behavior; the production window service passes the
   * normalized config mode explicitly.
   */
  positionMode?: KevinHudPositionMode | null
  /**
   * Retained for callers from the taller-title implementation. The native host
   * and the visible plate are the same height now, so this value is ignored.
   */
  plateHeight?: number | null
}

export interface KevinHudPlacement {
  /** Final window bounds in DIPs, fully inside the display work area. */
  bounds: KevinHudRect
  displayId: number
}

/**
 * The preset anchors the top center this many physical screen pixels below the
 * chosen display's work-area top. It is converted through that display's
 * scaleFactor before the DIP placement is clamped.
 */
export const KEVIN_HUD_PRESET_TOP_INSET = 16
/**
 * The native host always has at least the configured height. The renderer
 * starts its plate shorter than the host and expands it; there is no separate
 * native title stage.
 *
 * @deprecated Kept as a source-compatibility token for the old title sizing.
 */
export const KEVIN_HUD_ANNOUNCE_HEIGHT_SCALE = 1
/** The normal leading icon size; shared with the sizing contract. */
export const KEVIN_HUD_ICON_WIDTH = 22
/** Latin glyph advance at the 12 px base type, retained for old callers. */
export const KEVIN_HUD_CHAR_WIDTH = 7.2
/** The renderer/sizing contract never draws narrower than this. */
export const KEVIN_HUD_MIN_WIDTH = KEVIN_HUD_MIN_ALLOWED_WIDTH
/** Defensive upper bound on the deterministic estimate. */
export const KEVIN_HUD_MAX_WIDTH = KEVIN_HUD_MAX_ALLOWED_WIDTH

/**
 * Width-related config consumed by the deterministic measuring helper. Every
 * new field is optional so historical pure callers keep compiling; production
 * passes a normalized `KevinHudConfig`.
 */
export type KevinHudWidthConfig = KevinHudSizingConfig

export interface KevinHudContent {
  appName?: string | null
  /**
   * Trailing announcement status copy. Announcements reserve its measured
   * width (plus the title/status gap) so the right side never collides; a
   * settled monitor leaves it unset.
   */
  announceStatus?: string | null
  /**
   * Historical value bag. Telemetry strings are intentionally ignored for
   * width: the reserved per-metric templates own stable item widths. The
   * stable `appName` identity metadata is still honored.
   */
  values?: Partial<Record<KevinHudMetric, string | null>>
  /** Reported font family; retained for diagnostics/future exact measuring. */
  fontFamily?: string | null
}

function finite(value: number | undefined | null): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function positive(value: number | undefined | null, fallback: number): number {
  return finite(value) && value > 0 ? value : fallback
}

function validRect(value: KevinHudRect | null | undefined): KevinHudRect | null {
  if (!value) return null
  if (!finite(value.x) || !finite(value.y) || !finite(value.width) || !finite(value.height)) {
    return null
  }
  if (value.width <= 0 || value.height <= 0) return null
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

interface DisplayGeometry {
  bounds: KevinHudRect
  physicalBounds: KevinHudRect
  scaleFactor: number
}

function displayGeometry(
  display: KevinHudPhysicalDisplay | null | undefined
): DisplayGeometry | null {
  const bounds = validRect(display?.bounds)
  if (!bounds) return null
  const scaleFactor = positive(display?.scaleFactor, 1)
  const physicalBounds =
    validRect(display?.physicalBounds) ?? {
      x: bounds.x * scaleFactor,
      y: bounds.y * scaleFactor,
      width: bounds.width * scaleFactor,
      height: bounds.height * scaleFactor
    }
  return { bounds, physicalBounds, scaleFactor }
}

interface NormalizedDisplay {
  id: number
  bounds: KevinHudRect
  workArea: KevinHudRect
  physicalBounds: KevinHudRect
  scaleFactor: number
}

function normalizeDisplay(display: KevinHudDisplay | null | undefined): NormalizedDisplay | null {
  const geometry = displayGeometry(display)
  if (!geometry || !display) return null
  return {
    id: display.id,
    bounds: geometry.bounds,
    workArea: validRect(display.workArea) ?? geometry.bounds,
    physicalBounds: geometry.physicalBounds,
    scaleFactor: geometry.scaleFactor
  }
}

function overlapArea(a: KevinHudRect, b: KevinHudRect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

/**
 * Convert a native physical screen rect to DIP using the DPI of `display`.
 * The display must be the one chosen for the rect (see
 * `displayForPhysicalRect`). Returns null for malformed geometry.
 */
export function physicalRectToDip(
  physical: KevinHudPhysicalRect,
  display: KevinHudPhysicalDisplay
): KevinHudRect | null {
  const source = validRect(physical)
  const geometry = displayGeometry(display)
  if (!source || !geometry) return null
  const { bounds, physicalBounds, scaleFactor } = geometry
  return {
    x: bounds.x + (source.x - physicalBounds.x) / scaleFactor,
    y: bounds.y + (source.y - physicalBounds.y) / scaleFactor,
    width: source.width / scaleFactor,
    height: source.height / scaleFactor
  }
}

/**
 * Pick the display that visibly owns a physical game-window rect. The largest
 * overlap wins; with no overlap the nearest display center wins. This keeps
 * negative origins and mixed-DPI layouts deterministic.
 */
export function displayForPhysicalRect(
  displays: readonly KevinHudDisplay[],
  physical: KevinHudPhysicalRect
): KevinHudDisplay | null {
  const source = validRect(physical)
  if (!source) return null
  const candidates = displays
    .map(normalizeDisplay)
    .filter((display): display is NormalizedDisplay => display !== null)
  if (candidates.length === 0) return null

  const centerX = source.x + source.width / 2
  const centerY = source.y + source.height / 2
  let best: { display: NormalizedDisplay; overlap: number; distance: number } | null = null
  for (const display of candidates) {
    const overlap = overlapArea(source, display.physicalBounds)
    const dx = centerX - (display.physicalBounds.x + display.physicalBounds.width / 2)
    const dy = centerY - (display.physicalBounds.y + display.physicalBounds.height / 2)
    const distance = dx * dx + dy * dy
    if (
      !best ||
      overlap > best.overlap ||
      (overlap === best.overlap && distance < best.distance)
    ) {
      best = { display, overlap, distance }
    }
  }
  return best ? best.display : null
}

function metricGeometry(content: KevinHudContent): KevinHudItemGeometry {
  // `appName` is stable identity metadata, not an instantaneous telemetry
  // sample. Every other entry in the historical `values` bag is ignored.
  const legacyName = content?.values?.appName
  return {
    appName: content?.appName ?? (typeof legacyName === 'string' ? legacyName : null)
  }
}

const METRIC_SET = new Set<string>(KEVIN_HUD_METRICS)

function orderedMetrics(metrics: readonly KevinHudMetric[] | null | undefined): KevinHudMetric[] {
  if (!Array.isArray(metrics)) return []
  const seen = new Set<string>()
  const result: KevinHudMetric[] = []
  for (const metric of metrics) {
    if (typeof metric !== 'string' || !METRIC_SET.has(metric) || seen.has(metric)) continue
    seen.add(metric)
    result.push(metric as KevinHudMetric)
  }
  return result
}

interface KevinHudWidthRange {
  min: number
  max: number
}

/**
 * Resolve the persisted min/max range. `autoWidth: false` historically meant a
 * fixed width. The sizing contract keeps that historical `min === max` when no
 * explicit cap exists, while an explicitly supplied larger `maxWidth` is
 * honored as a non-binding cap above the manual width.
 */
function widthBounds(config: KevinHudWidthConfig): KevinHudWidthRange {
  const bounds: KevinHudWidthBounds = resolveKevinHudWidthBounds(config)
  return {
    min: bounds.minWidth,
    max: Math.max(bounds.minWidth, bounds.maxWidth)
  }
}

function fitWidth(config: KevinHudWidthConfig, desiredWidth: number): number {
  const { min, max } = widthBounds(config)
  if (!finite(desiredWidth) || desiredWidth <= 0) return min
  return Math.round(Math.min(max, Math.max(min, desiredWidth)))
}

/**
 * Raw content width before fitting: reserved item slots, configured item gaps,
 * both horizontal content paddings, the drawn border and the optional fixed
 * announcement status. No telemetry sample string is read; only stable
 * templates, the optional `appName` geometry and that status copy participate.
 */
export function measureKevinHudContentWidth(
  config: KevinHudWidthConfig,
  content: KevinHudContent = {}
): number {
  const metrics = orderedMetrics(config.metrics)
  const padding = resolveKevinHudContentPadding(config)
  const gap = resolveKevinHudItemGap(config)
  const border = finite(config.borderWidth)
    ? Math.min(6, Math.max(0, config.borderWidth))
    : 0
  let width = padding.horizontal * 2 + border * 2
  const statusText = typeof content.announceStatus === 'string'
    ? content.announceStatus.trim()
    : ''
  const trailingStatus = statusText
    ? measureKevinHudAnnounceStatusWidth(config, statusText) +
      KEVIN_HUD_ANNOUNCE_STATUS_GAP
    : 0
  width += trailingStatus
  if (metrics.length === 0) return Math.ceil(width)
  const geometry = metricGeometry(content)
  let items = 0
  for (const metric of metrics) {
    items += measureKevinHudItemWidth(config, metric, geometry)
  }
  return Math.ceil(width + items + Math.max(0, metrics.length - 1) * gap)
}

/**
 * Deterministic content width fitted into the persisted min/max range.
 *
 * `width` is the minimum/manual width and `maxWidth` is the cap. Historical
 * fixed-width configs resolve `maxWidth === width` (see normalization), so the
 * old fixed-width behavior is preserved without inspecting `autoWidth` again.
 * Telemetry strings never participate: only the selected metrics, their
 * reserved bounded templates, the configured item typography/gaps/padding, the
 * optional `appName` geometry and the fixed announcement status affect the
 * result.
 */
export function measureKevinHudWidth(
  config: KevinHudWidthConfig,
  content: KevinHudContent = {}
): number {
  return fitWidth(config, measureKevinHudContentWidth(config, content))
}

/** The geometry inputs needed to derive a frame's native target height. */
export interface KevinHudHeightInput {
  phase: KevinHudFrame['phase']
  config: Pick<KevinHudConfig, 'height'> & Partial<Omit<KevinHudConfig, 'height'>>
}

/**
 * The configured HUD height from the saved dimensions, in DIPs. This is the
 * user-owned lower bound; `measureKevinHudTargetHeight` may raise it when the
 * selected item typography plus padding needs more room.
 */
export function measureKevinHudBaseHeight(config: Pick<KevinHudConfig, 'height'>): number {
  const configured = config?.height
  const base = finite(configured) && configured > 0
    ? configured
    : KEVIN_HUD_DEFAULT_HEIGHT
  return Math.max(1, Math.round(base))
}

function sizingFor(config: KevinHudHeightInput['config']): KevinHudSizingConfig {
  return {
    ...config,
    width: finite(config.width) && config.width > 0
      ? config.width
      : KEVIN_HUD_DEFAULT_WIDTH,
    metrics: Array.isArray(config.metrics) ? config.metrics : []
  }
}

/**
 * Retained source-compatible alias for the old title-stage measurement.
 * The native host reserves at least the configured height; it can be taller
 * when the selected item typography plus padding needs more room.
 *
 * @deprecated Use `measureKevinHudTargetHeight`.
 */
export function measureKevinHudPeakHeight(
  config: KevinHudHeightInput['config']
): number {
  return Math.max(
    measureKevinHudBaseHeight(config),
    measureKevinHudMinContentHeight(sizingFor(config))
  )
}

/**
 * Native window height for a frame, in DIPs.
 *
 * The user's configured height is the lower bound. The selected item style may
 * require more room for its descriptor/value line boxes plus content padding
 * and border; that requirement raises the native host (and therefore the
 * settled plate) instead of clipping or wrapping. Announce, monitor and exit
 * all share this one height. Only `placeKevinHud` may shorten the host through
 * its work-area safety clamp.
 *
 * `previousVisibleHeight` is retained for callers from the old exit contract and
 * is deliberately ignored: native height never depends on a prior phase.
 */
export function measureKevinHudTargetHeight(
  frame: KevinHudHeightInput,
  _previousVisibleHeight: number | null = null
): number {
  return measureKevinHudPeakHeight(frame?.config ?? { height: KEVIN_HUD_DEFAULT_HEIGHT })
}

/**
 * Production configs always have a normalized mode (default `preset`). The
 * optional read keeps this module compatible with callers/configs from before
 * the mode existed and treats them as preset.
 */
export function readKevinHudPositionMode(config: unknown): KevinHudPositionMode {
  if (config && typeof config === 'object') {
    const value = (config as { positionMode?: unknown }).positionMode
    if (value === 'custom') return 'custom'
  }
  return 'preset'
}

/**
 * Convenience wrapper for a complete frame.
 *
 * Announcements render the dedicated triangle + round icon + actual name +
 * "启动中" row, so their width is measured from that launch geometry and never
 * from the settled monitoring item styles. The settled monitor measures every
 * selected metric using the stable reserved templates. An exit retains the last
 * visible width so its reverse animation cannot reflow or move underneath
 * itself.
 */
export function measureKevinHudFrameWidth(
  frame: KevinHudFrame,
  previousVisibleWidth: number | null = null
): number {
  if (
    frame?.phase === 'exit' &&
    finite(previousVisibleWidth) &&
    previousVisibleWidth > 0
  ) {
    return Math.max(1, Math.round(previousVisibleWidth))
  }

  if (frame?.phase === 'announce') {
    return fitWidth(
      frame.config,
      measureKevinHudAnnouncementWidth(
        frame.config,
        frame.appName,
        KEVIN_HUD_ANNOUNCE_STATUS_TEXT
      )
    )
  }

  return measureKevinHudWidth(frame.config, { appName: frame.appName })
}

function percentage(value: number): number {
  if (!finite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

function resolveTarget(
  input: KevinHudPlacementInput,
  displays: readonly NormalizedDisplay[],
  primary: NormalizedDisplay
): { display: NormalizedDisplay; target: KevinHudRect } {
  if (input.monitor !== 'game') return { display: primary, target: primary.workArea }

  const hint = input.displayHint
  if (hint?.gameWindowRect) {
    const display = displayForPhysicalRect(displays, hint.gameWindowRect)
    if (display) {
      // The game window only chooses the screen. Offsets stay relative to the
      // chosen display's work area instead of its movable sub-rectangle.
      const normalized = normalizeDisplay(display)
      if (normalized) return { display: normalized, target: normalized.workArea }
    }
  }

  if (finite(hint?.displayId)) {
    const display = displays.find(candidate => candidate.id === hint?.displayId)
    if (display) return { display, target: display.workArea }
  }

  return { display: primary, target: primary.workArea }
}

/**
 * Place the HUD inside a display work area.
 *
 * The `preset` mode is the reference behavior: top center, with the native host
 * top 16 physical pixels below the chosen work-area top. The inset is converted
 * through the chosen display's scaleFactor. The native host is exactly the
 * configured height, so the visible plate's settled top is that same inset.
 * `custom` (and direct pure calls with no explicit mode) is the original
 * behavior: x is the anchor point across the target and y is the top edge across
 * the target. The final DIP bounds are rounded, fitted to the work area, and can
 * never be clipped by taskbars or edges.
 */
export function placeKevinHud(input: KevinHudPlacementInput): KevinHudPlacement | null {
  if (!finite(input.width) || !finite(input.height) || input.width <= 0 || input.height <= 0) {
    return null
  }
  const displays = (input.displays ?? [])
    .map(normalizeDisplay)
    .filter((display): display is NormalizedDisplay => display !== null)
  if (displays.length === 0) return null
  const primary = displays.find(display => display.id === input.primaryDisplayId) ?? displays[0]
  const { display, target } = resolveTarget(input, displays, primary)

  const work = display.workArea
  const workLeft = Math.ceil(work.x)
  const workTop = Math.ceil(work.y)
  const workWidth = Math.max(1, Math.floor(work.x + work.width) - workLeft)
  const workHeight = Math.max(1, Math.floor(work.y + work.height) - workTop)
  const width = Math.max(1, Math.min(Math.round(input.width), workWidth))
  const height = Math.max(1, Math.min(Math.round(input.height), workHeight))

  const preset = input.positionMode === 'preset'
  let requestedLeft: number
  let requestedTop: number
  if (preset) {
    requestedLeft = work.x + work.width / 2 - width / 2
    requestedTop = work.y + KEVIN_HUD_PRESET_TOP_INSET / display.scaleFactor
  } else {
    const anchor = input.anchor === 'left' || input.anchor === 'right' ? input.anchor : 'center'
    const anchorX = target.x + (target.width * percentage(input.x)) / 100
    requestedLeft =
      anchor === 'left' ? anchorX : anchor === 'right' ? anchorX - width : anchorX - width / 2
    requestedTop = target.y + (target.height * percentage(input.y)) / 100
  }

  const maxLeft = workLeft + workWidth - width
  const maxTop = workTop + workHeight - height
  const x = Math.min(Math.max(Math.round(requestedLeft), workLeft), maxLeft)
  const y = Math.min(Math.max(Math.round(requestedTop), workTop), maxTop)
  return {
    bounds: { x, y, width, height },
    displayId: display.id
  }
}
