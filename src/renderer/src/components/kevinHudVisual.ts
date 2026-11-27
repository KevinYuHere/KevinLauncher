/**
 * Pure visual calculations for the Kevin HUD.
 *
 * The shared motion module owns the finite cue values, the CSS file draws the
 * matching reversible keyframes, and everything in this module is a
 * deterministic function of the frame's configuration. Keeping colour/layout
 * arithmetic here makes the React part small and testable without a DOM.
 */
import {
  DEFAULT_KEVIN_HUD,
  KEVIN_HUD_ITEM_STYLE_LIMITS,
  KEVIN_HUD_METRICS,
  type KevinHudAnchor,
  type KevinHudConfig,
  type KevinHudDirection,
  type KevinHudFrame,
  type KevinHudItemAlign,
  type KevinHudMetric
} from '@shared/kevinHud'
import {
  kevinHudGradientCss,
  normalizeKevinHudGradient,
  type KevinHudGradient
} from '@shared/kevinHudBackground'
import {
  KEVIN_HUD_MOTION_TOTAL_MS,
  KEVIN_HUD_REVEAL_BASE_DELAY_MS,
  KEVIN_HUD_REVEAL_DURATION_MS,
  KEVIN_HUD_REVEAL_MAX_DELAY_MS,
  KEVIN_HUD_REVEAL_STAGGER_MS,
  kevinHudDirectionVars
} from '@shared/kevinHudMotion'
import {
  KEVIN_HUD_ANNOUNCE_STATUS_GAP,
  KEVIN_HUD_ANNOUNCE_STATUS_SIZE,
  KEVIN_HUD_ANNOUNCE_STATUS_TRACKING,
  KEVIN_HUD_DEFAULT_ITEM_GAP,
  KEVIN_HUD_MEMORY_READOUT_MIN_WIDTH,
  KEVIN_HUD_METRIC_TEMPLATES,
  getKevinHudItemStyle,
  measureKevinHudItemWidth,
  measureKevinHudMinContentHeight,
  measureKevinHudValueWidth,
  resolveKevinHudContentPadding,
  resolveKevinHudItemGap,
  resolveKevinHudWidthBounds,
  type KevinHudItemStyle,
  type KevinHudSizingConfig
} from '@shared/kevinHudSizing'
import {
  MATERIAL_DEFAULTS,
  type GlassAppearance,
  type GlassMaterial
} from '@shared/types'

export type KevinHudCssVars = Record<`--khud-${string}`, string>

/**
 * Forward-compatible per-item colour fields owned by the shared config
 * contract. Keeping this structural shape makes the renderer tolerate both a
 * legacy beta config (no colour fields) and a newer normalized one without a
 * second, conflicting source of defaults.
 */
export interface KevinHudItemColorFields {
  descriptionColor?: string | null
  valueColor?: string | null
}

/** Resolved item presentation plus the two optional per-item colours. */
export type KevinHudRenderItemStyle = KevinHudItemStyle & KevinHudItemColorFields

export interface KevinHudItemAlignment {
  description: KevinHudItemAlign
  value: KevinHudItemAlign
  /**
   * `left`/`right`/`center` mean both parts form one group on that edge.
   * `split` means the two parts hug opposite edges; `mixed` means one part is
   * centred while the other stays on its chosen side.
   */
  mode: 'left' | 'right' | 'center' | 'split' | 'mixed'
  center: 'description' | 'value' | null
  /** True for right description + left value (visual order value → description). */
  reverse: boolean
}

const DEFAULT_DESCRIPTION_ALIGN: KevinHudItemAlign = 'left'
const DEFAULT_VALUE_ALIGN: KevinHudItemAlign = 'right'

const isItemAlign = (value: unknown): value is KevinHudItemAlign =>
  value === 'left' || value === 'center' || value === 'right'

const clampMinWidth = (value: number): number =>
  Math.min(
    KEVIN_HUD_ITEM_STYLE_LIMITS.minWidth[1],
    Math.max(KEVIN_HUD_ITEM_STYLE_LIMITS.minWidth[0], value)
  )

function normalizeItemAlign(
  value: unknown,
  fallback: KevinHudItemAlign
): KevinHudItemAlign {
  return isItemAlign(value) ? value : fallback
}

/**
 * Resolve the pure description/value alignment rule used by the CSS cell
 * layout. The renderer and the offscreen layout smoke share this function so
 * the visual order and the centring rule cannot drift.
 */
export function kevinHudItemAlignment(
  style: Partial<KevinHudItemStyle> | null | undefined
): KevinHudItemAlignment {
  const description = normalizeItemAlign(
    style?.descriptionAlign,
    DEFAULT_DESCRIPTION_ALIGN
  )
  const value = normalizeItemAlign(style?.valueAlign, DEFAULT_VALUE_ALIGN)
  if (description === value) {
    return {
      description,
      value,
      mode: description,
      center: null,
      reverse: false
    }
  }
  if (description === 'center' || value === 'center') {
    return {
      description,
      value,
      mode: 'mixed',
      center: description === 'center' ? 'description' : 'value',
      reverse: false
    }
  }
  return {
    description,
    value,
    mode: 'split',
    center: null,
    reverse: description === 'right' && value === 'left'
  }
}

/**
 * Foreground opacity is fully independent from the background: it fades text,
 * artwork, glyphs, the progress ring, border, ripple and decorations, but never
 * the plate fill, material highlight or glass backdrop.
 */
export function resolveKevinHudForegroundOpacity(
  config: KevinHudConfig | null | undefined
): number {
  const value = config?.foregroundOpacity
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 1
}

/**
 * Only these fields may be overridden per metric. Historical beta configs may
 * still carry per-item orientation, type sizes or bold flags; those are
 * presentation defaults now owned by the one app-wide `itemStyle`, so they must
 * never leak into a settled item or its measured slot.
 */
const PER_ITEM_OVERRIDE_KEYS = new Set([
  'gap',
  'minWidth',
  'descriptionAlign',
  'valueAlign',
  'descriptionColor',
  'valueColor'
])

/**
 * Strip legacy per-metric layout/type overrides before handing a config to the
 * shared measurement helpers. The public per-item surface is the shared
 * gap/minimum-width/alignment/colour patch; every other attribute belongs to
 * the app-wide `itemStyle`.
 */
export function kevinHudItemStylesForLayout(
  styles: KevinHudSizingConfig['itemStyles']
): KevinHudSizingConfig['itemStyles'] {
  if (styles === null || typeof styles !== 'object') return styles
  const result: Record<string, unknown> = {}
  for (const [metric, value] of Object.entries(styles)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const source = value as Record<string, unknown>
    const next: Record<string, unknown> = {}
    for (const key of Object.keys(source)) {
      if (PER_ITEM_OVERRIDE_KEYS.has(key)) next[key] = source[key]
    }
    if (Object.keys(next).length > 0) result[metric] = next
  }
  return result as KevinHudSizingConfig['itemStyles']
}

function kevinHudLayoutConfig(
  config: KevinHudSizingConfig | null | undefined
): KevinHudSizingConfig {
  if (!config || !config.itemStyles) return config ?? {}
  return {
    ...config,
    itemStyles: kevinHudItemStylesForLayout(config.itemStyles)
  }
}

/**
 * Resolve one item's typography using only the contract's per-item overrides.
 * Shared sizing still owns the descriptor, line height and width arithmetic;
 * this wrapper only prevents a legacy beta override from replacing it.
 *
 * The settled app identity is now an ordinary row item: it follows the
 * app-wide orientation, type size and weight, while its descriptor is always
 * the real app icon and its own gap/minWidth/alignment/colour patch still
 * applies. The launch announcement keeps its own fixed identity layout.
 */
export function resolveKevinHudItemStyle(
  config: KevinHudSizingConfig | null | undefined,
  metric: KevinHudMetric
): KevinHudRenderItemStyle {
  // The shared resolver already merges the app-wide presentation with the
  // allowed per-metric patch, preserves an explicit per-item `null` reset, and
  // pins the merged appName descriptor to the real icon. The layout config
  // strips legacy beta fields before that merge.
  const base = getKevinHudItemStyle(kevinHudLayoutConfig(config), metric)
  return {
    ...base,
    minWidth: clampMinWidth(
      typeof base.minWidth === 'number' && Number.isFinite(base.minWidth)
        ? base.minWidth
        : 0
    ),
    descriptionAlign: normalizeItemAlign(
      base.descriptionAlign,
      DEFAULT_DESCRIPTION_ALIGN
    ),
    valueAlign: normalizeItemAlign(base.valueAlign, DEFAULT_VALUE_ALIGN),
    descriptionColor: base.descriptionColor ?? null,
    valueColor: base.valueColor ?? null
  }
}

export interface KevinHudRgba {
  r: number
  g: number
  b: number
  a: number
}

export interface KevinHudMetricText {
  text: string
  unavailable: boolean
}

export interface KevinHudRowLayout {
  layout: 'single'
  /** Always one row; every chosen value metric shares the same line. */
  rows: KevinHudMetric[][]
}

export interface KevinHudRevealOriginInput {
  anchor: KevinHudAnchor
  direction: KevinHudDirection
  /**
   * Final horizontal centre of the element in the settled surface coordinate
   * space. The renderer measures this from the real layout, not from animation
   * transforms, so an entrance and its reverse use the same origin.
   */
  centerX: number
  /** Settled surface width; the horizontal alignment reference. */
  surfaceWidth: number
  /** Position in the reveal order (0-based). */
  index: number
  /** Number of revealed items, excluding the leading identity block. */
  count: number
  /** The leading icon/name block always leaves away from the aligned edge. */
  leading?: boolean
}

export interface KevinHudRevealOrigin {
  /** Signed horizontal start offset; zero is the settled position. */
  x: number
  /** Signed vertical start offset for the top/bottom presets. */
  y: number
  /** Entrance stagger. */
  delayMs: number
  /** Reversed stagger so closing retracts in the entrance's reverse order. */
  exitDelayMs: number
}

export interface KevinHudSurfaceVisual {
  vars: KevinHudCssVars
  material: GlassMaterial
  /** `null` means "preserve the original app icon colours". */
  iconTint: string | null
  /** Normalized gradient, only while the gradient background mode is active. */
  gradient: KevinHudGradient | null
}

export interface KevinHudItemVisual {
  style: KevinHudRenderItemStyle
  /** Entire reserved slot, including description, gap and inline padding. */
  width: number
  /** Right-aligned value reserve; the merged app identity reserves its name. */
  valueWidth: number
  vars: KevinHudCssVars
}

const kevinHudItemIconSize = (style: KevinHudItemStyle): number =>
  Math.max(12, Math.ceil(style.descriptionSize * 1.35))

/**
 * Resolve one item's stable slot and CSS variables. These variables are set on
 * the same cell on every sample and contain no measured value text, so an
 * ordinary telemetry update can never reflow the row or restart its entrance.
 *
 * The merged `appName` item passes its actual name into the shared reserve, so
 * its slot covers the real icon description, the configured gap and the actual
 * name value. The bank's existing overflow scroll reveals a name longer than
 * the host; it is never ellipsized.
 */
export function resolveKevinHudItemVisual(
  config: KevinHudSizingConfig,
  metric: KevinHudMetric,
  appName?: string | null
): KevinHudItemVisual {
  const layoutConfig = kevinHudLayoutConfig(config)
  const style = resolveKevinHudItemStyle(config, metric)
  // The icon uses the descriptor size, while the value uses the value size and
  // weight. Pass that resolved icon size so the shared reserve matches the
  // rendered description slot. The user's DIP floor is a whole-cell lower
  // bound: it widens a short item but never caps a wider content reserve. The
  // dedicated memory composition also receives it as a separate token.
  const measuredWidth = measureKevinHudItemWidth(layoutConfig, metric, {
    appName,
    iconSize: kevinHudItemIconSize(style)
  })
  const width = Math.max(measuredWidth, style.minWidth)
  const valueWidth = measureKevinHudValueWidth(layoutConfig, metric, { appName })
  return {
    style,
    width,
    valueWidth,
    vars: {
      '--khud-cell-width': `${width}px`,
      '--khud-cell-min-width': `${style.minWidth}px`,
      '--khud-value-width': `${valueWidth}px`,
      '--khud-copy-gap': `${style.gap}px`,
      '--khud-description-align': style.descriptionAlign,
      '--khud-value-align': style.valueAlign,
      '--khud-item-description-size': `${style.descriptionSize}px`,
      '--khud-item-value-size': `${style.valueSize}px`,
      '--khud-item-icon-size': `${kevinHudItemIconSize(style)}px`,
      '--khud-description-weight': style.descriptionBold ? '700' : '500',
      '--khud-value-weight': style.valueBold ? '650' : '450',
      // Null follows the unified, contrast-checked text colour. The value is
      // pure white by default; the description keeps the reference's light
      // white instead of the old 50% grey.
      '--khud-item-description-color':
        style.descriptionColor ??
        'color-mix(in srgb, var(--khud-text, #ffffff) 82%, transparent)',
      '--khud-item-value-color': style.valueColor ?? 'var(--khud-text, #ffffff)'
    }
  }
}

export interface KevinHudPlacement {
  left: string
  top: string
  transform: string
}

export interface KevinHudRippleVisual {
  /** Clamped 0…2 ripple setting, kept in the CSS token for diagnostics. */
  strength: number
  /** Peak border opacity; the default of 1 keeps the original 0.24. */
  peakOpacity: number
  /** End scale of the inner border; the strongest setting visibly contracts. */
  endScale: number
}

export interface KevinHudVisualOptions {
  /**
   * Frame phase. The dedicated HUD window has already been resized by the main
   * process, so an announcement's effective height is the expanded 1.5x value.
   */
  phase?: KevinHudFrame['phase']
  /** `window` follows the dedicated host geometry; `viewport` is a preview. */
  host?: 'window' | 'viewport'
  /** On exit, the visible phase that must be played backwards. */
  exitFrom?: 'announce' | 'monitor' | null
}

export interface KevinHudPlateGeometry {
  /** Every settled phase uses exactly this configured height. */
  height: number
  /** Shorter entrance pose; the reverse exit contracts back to it. */
  openHeight: number
  /** Every settled phase uses exactly this configured radius. */
  radius: number
  /** Slightly tighter entrance/reverse-exit corner. */
  openRadius: number
  /**
   * Compatibility aliases retained for callers of the original geometry
   * contract. Both now equal the settled configured values.
   */
  baseHeight: number
  expandedHeight: number
  baseRadius: number
  expandedRadius: number
  /** True for the announcement / its reverse; it never changes the height. */
  expanded: boolean
}

/**
 * Motion ranges mirror `KevinHudConfig` in `@shared/kevinHud`, not the old
 * renderer-only 0…1 ranges. Keep the documented default (bounce 0.275, ripple 1)
 * pixel-identical so existing saved HUDs do not change when opened.
 */
const BOUNCE_RANGE = { min: 0, max: 0.5, fallback: 0.275 } as const
const RIPPLE_RANGE = { min: 0, max: 2, fallback: 1 } as const

const METRIC_ARIA_LABELS: Record<KevinHudMetric, string> = {
  appName: '应用名称',
  sessionTime: '本次会话',
  totalTime: '累计时长',
  fps: '帧率',
  gpu: '显卡',
  cpu: '处理器',
  memory: '内存',
  download: '下行',
  upload: '上行',
  clock: '时钟'
}

const METRIC_SET = new Set<string>(KEVIN_HUD_METRICS)
const MATERIAL_SET = new Set<string>(Object.keys(MATERIAL_DEFAULTS))
const DEFAULT_MATERIAL: GlassMaterial = 'blur'

const clamp = (value: number, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback

const isMaterial = (value: unknown): value is GlassMaterial =>
  typeof value === 'string' && MATERIAL_SET.has(value)

/** Keep only known metrics, removing repeats while preserving the display order. */
export function orderKevinHudMetrics(
  metrics: readonly unknown[] | null | undefined
): KevinHudMetric[] {
  if (!Array.isArray(metrics)) return []
  const seen = new Set<KevinHudMetric>()
  const result: KevinHudMetric[] = []
  for (const value of metrics) {
    if (typeof value !== 'string' || !METRIC_SET.has(value)) continue
    const metric = value as KevinHudMetric
    if (seen.has(metric)) continue
    seen.add(metric)
    result.push(metric)
  }
  return result
}

export function kevinHudMetricLabel(metric: KevinHudMetric): string {
  return KEVIN_HUD_METRIC_TEMPLATES[metric]?.label ?? ''
}

export function kevinHudMetricAriaLabel(metric: KevinHudMetric): string {
  return METRIC_ARIA_LABELS[metric] ?? metric
}

/**
 * Values such as `171 FPS` or `GPU 88%` already carry their own label. Repeating
 * it as a separate eyebrow is the redundant decoration the corrected HUD
 * removes; an actually bare value such as `171` or `88%` keeps its label.
 */
export function kevinHudMetricShowsLabel(
  metric: KevinHudMetric,
  value: string | null | undefined
): boolean {
  const label = kevinHudMetricLabel(metric)
  if (!label) return false
  const text = typeof value === 'string' ? value.trim().toUpperCase() : ''
  if (!text) return true
  return !text.includes(label.toUpperCase())
}

/**
 * Normalize a formatted value for display. An unavailable metric is never
 * rendered as a blank segment: the visual fallback is always the two dashes.
 */
export function formatKevinHudValue(value: string | null | undefined): KevinHudMetricText {
  if (typeof value !== 'string' || value.trim() === '') {
    return { text: '--', unavailable: true }
  }
  return { text: value.trim(), unavailable: false }
}

/** Parsing is deliberately strict: persisted colours are six-digit hex values. */
export function parseKevinHudHex(value: string | null | undefined): KevinHudRgba | null {
  if (typeof value !== 'string') return null
  const match = /^#([\da-f]{6})$/i.exec(value.trim())
  if (!match) return null
  const digits = match[1]
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
    a: 1
  }
}

export function kevinHudHex(value: string | null | undefined): string | null {
  return typeof value === 'string' && parseKevinHudHex(value) ? value.trim() : null
}

const channelLuminance = (channel: number): number => {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function kevinHudLuminance(color: KevinHudRgba): number {
  return (
    0.2126 * channelLuminance(color.r) +
    0.7152 * channelLuminance(color.g) +
    0.0722 * channelLuminance(color.b)
  )
}

const contrastRatio = (a: number, b: number): number =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

/** Composite a (possibly transparent) fill over a neutral, dark HUD backdrop. */
export function compositeKevinHudFill(
  color: KevinHudRgba,
  opacity: number
): KevinHudRgba {
  const under = { r: 18, g: 19, b: 21 }
  const alpha = clamp(opacity, 0, 1, 1) * clamp(color.a, 0, 1, 1)
  return {
    r: Math.round(color.r * alpha + under.r * (1 - alpha)),
    g: Math.round(color.g * alpha + under.g * (1 - alpha)),
    b: Math.round(color.b * alpha + under.b * (1 - alpha)),
    a: 1
  }
}

/** Black or white, whichever wins against the effective HUD fill. */
export function readableKevinHudText(fill: KevinHudRgba, opacity: number): string {
  const background = compositeKevinHudFill(fill, opacity)
  const luminance = kevinHudLuminance(background)
  const whiteContrast = contrastRatio(1, luminance)
  const blackContrast = contrastRatio(0, luminance)
  return whiteContrast >= blackContrast ? '#ffffff' : '#0c0d0f'
}

const rgbaFromHex = (color: KevinHudRgba, alpha: number): string =>
  `rgba(${color.r}, ${color.g}, ${color.b}, ${clamp(alpha, 0, 1, 1).toFixed(3)})`

/**
 * One conservative fill sample for automatic text contrast on a gradient. A
 * gradient naturally varies along its axis, so the average of its validated
 * stops is the quietest single answer available without sampling the window.
 */
function averageGradientFill(gradient: KevinHudGradient): KevinHudRgba {
  let r = 0
  let g = 0
  let b = 0
  let count = 0
  for (const stop of gradient.stops) {
    const color = parseKevinHudHex(stop.color)
    if (!color) continue
    r += color.r
    g += color.g
    b += color.b
    count += 1
  }
  if (count === 0) return { r: 49, g: 47, b: 48, a: 1 }
  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
    a: 1
  }
}

/**
 * A calm, monochrome fallback for "app glass" when the HUD is rendered outside
 * the launcher's theme root. Inside the launcher the real `--glass*` tokens win.
 */
const glassFallback = (appearance: GlassAppearance | null, material: GlassMaterial): KevinHudRgba => {
  const defaults = MATERIAL_DEFAULTS[material]
  const brightness = clamp(appearance?.brightness ?? 0, 0, 100, 0)
  const influence = clamp(appearance?.opacity ?? 62, 0, 100, 62)
  const t = brightness / 100
  const color: KevinHudRgba = {
    r: Math.round(14 + (228 - 14) * t),
    g: Math.round(16 + (225 - 16) * t),
    b: Math.round(19 + (218 - 19) * t),
    a: clamp(0.88 - (influence / 100) * 0.52, 0.24, 0.9, 0.5)
  }
  return { ...color, a: color.a * (defaults.opacity / 100) }
}

const materialFilter = (material: GlassMaterial, appearance: GlassAppearance | null): string => {
  const defaults = MATERIAL_DEFAULTS[material]
  const blur = clamp(appearance?.blur ?? defaults.blur, 0, 48, defaults.blur)
  const saturation = clamp(
    appearance?.saturation ?? defaults.saturation,
    0,
    260,
    defaults.saturation
  )
  const extra = material === 'mica' ? ' brightness(1.035)' : ''
  return `blur(${blur.toFixed(1)}px) saturate(${saturation.toFixed(0)}%)${extra}`
}

/**
 * Map a bounce setting (0…0.5) to a CSS timing function. The vertical control
 * point rises above one, producing the compact HUD's spring overshoot without
 * a JavaScript animation loop. The original curve is preserved at the shared
 * default of 0.275, while the attached maximum now has a real upper bound.
 */
export function kevinHudSpring(bounce: number): string {
  const amount = clamp(bounce, BOUNCE_RANGE.min, BOUNCE_RANGE.max, BOUNCE_RANGE.fallback)
  const overshoot = (1 + amount * 1.8).toFixed(3)
  return `cubic-bezier(0.16, ${overshoot}, 0.24, 1)`
}

/**
 * Translate the ripple setting (0…2) into a peak opacity and end scale.
 *
 * The lower half retains the previous 0.24×strength faint-edge pulse and the
 * 0.3% outward drift at the default. Above 1 the ring deliberately contracts
 * (up to 6% at 2) instead of growing further outside the clipped surface, so
 * the maximum setting is visibly different while default HUDs are unchanged.
 */
export function kevinHudRipple(ripple: number): KevinHudRippleVisual {
  const strength = clamp(ripple, RIPPLE_RANGE.min, RIPPLE_RANGE.max, RIPPLE_RANGE.fallback)
  const endScale =
    strength <= 1
      ? 1 + 0.003 * strength
      : 1.003 - 0.063 * (strength - 1)
  return {
    strength,
    peakOpacity: 0.24 * strength,
    endScale
  }
}

/** Position the anchor wrapper; the surface animates independently inside it. */
export function kevinHudPlacement(
  anchor: KevinHudAnchor,
  x: number,
  y: number
): KevinHudPlacement {
  const left = clamp(x, 0, 100, 50)
  const top = clamp(y, 0, 100, 3)
  const transform =
    anchor === 'left'
      ? 'translateX(0)'
      : anchor === 'right'
        ? 'translateX(-100%)'
        : 'translateX(-50%)'
  return {
    left: `${left}%`,
    top: `${top}%`,
    transform
  }
}

/**
 * Smallest readable value cell. The CSS binary exposes the same value as
 * `--khud-cell-min`; keeping the constant here lets the pure/test surface and
 * the rendered row agree instead of silently shrinking values into ellipses.
 */
export const KEVIN_HUD_MIN_CELL_PX = 54

/**
 * Backwards-compatible token for the historical default gap between revealed
 * items. The live value now comes from `itemGap`; this constant documents the
 * default used when that optional field has not landed yet.
 */
export const KEVIN_HUD_MIN_CELL_GAP_PX = KEVIN_HUD_DEFAULT_ITEM_GAP

/** Horizontal start offset stays inside this readable, quiet range. */
export const KEVIN_HUD_MAX_REVEAL_X = 30

/**
 * Every chosen item shares one row. `autoWidth` no longer splits the bank:
 * with fixed width the row scrolls, and with auto width the native window can
 * widen first; both use the same single-row contract.
 */
export function layoutKevinHudRows(
  metrics: readonly KevinHudMetric[],
  _autoWidth?: boolean
): KevinHudRowLayout {
  if (metrics.length === 0) return { layout: 'single', rows: [] }
  return { layout: 'single', rows: [metrics.slice()] }
}

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback

/**
 * Resolve the horizontal/vertical start offset for one visible element.
 *
 * The configured anchor owns the horizontal origin:
 * - `left` alignment starts every slot to the left of its settled pose and
 *   advances right;
 * - `right` alignment is the mirror image;
 * - `center` alignment opens away from the middle: a left slot starts to the
 *   right of its settled pose (and moves left), a right slot starts to the left
 *   (and moves right), and a slot exactly on the centre line does not travel
 *   horizontally at all.
 * The leading identity block follows the configured horizontal direction first,
 * then the alignment edge. With a centred anchor and a centre preset it keeps
 * the quiet leading-edge reveal (a little left of its settled pose); a vertical
 * preset adds only its vertical travel. Top/bottom directional presets
 * additionally start above/below the surface. The returned values are finite,
 * bounded and depend only on settled geometry.
 */
export function kevinHudRevealOrigin(
  input: KevinHudRevealOriginInput
): KevinHudRevealOrigin {
  const width = Math.max(1, finiteOr(input.surfaceWidth, 1))
  const centerX = Math.min(width * 2, Math.max(-width, finiteOr(input.centerX, width / 2)))
  const anchorX = input.anchor === 'left' ? 0 : input.anchor === 'right' ? width : width / 2
  const leading = input.leading === true
  // A slot on the middle line has no natural side. Keep it still instead of
  // turning sub-pixel measurement jitter into a visible horizontal step.
  const centeredSlot =
    Math.abs(centerX - width / 2) <= 0.5 ? 0 : centerX < width / 2 ? 1 : -1
  // The leading identity block follows the configured horizontal direction;
  // centre/vertical presets fall back to the alignment edge, and a centred
  // centre-direction identity keeps the original quiet leftward reveal. Data
  // slots are alignment-owned: centred slots open away from the middle (the
  // left slot starts right of its settled pose, the right slot starts left of
  // it), while left/right anchors open from their own edge. The exit reuses the
  // same origin on the reversed clock, so its visible movement is exactly the
  // opposite of the opening.
  const directionSign =
    input.direction === 'left' ? -1 : input.direction === 'right' ? 1 : 0
  const anchorSign =
    input.anchor === 'left' ? -1 : input.anchor === 'right' ? 1 : 0
  const sign = leading
    ? directionSign !== 0
      ? directionSign
      : anchorSign !== 0
        ? anchorSign
        : input.direction === 'center'
          ? -1
          : 0
    : input.anchor === 'left'
      ? -1
      : input.anchor === 'right'
        ? 1
        : centeredSlot
  // Leading identity keeps its travel calm even when the text is long.
  const distance = Math.min(width, Math.abs(centerX - anchorX))
  const amplitude = leading
    ? Math.min(18, Math.max(12, distance * 0.04 + 12))
    : Math.min(
        KEVIN_HUD_MAX_REVEAL_X,
        Math.max(12, distance * 0.075 + 12)
      )
  const count = Math.max(0, Math.floor(finiteOr(input.count, 0)))
  const index = Math.min(Math.max(0, Math.floor(finiteOr(input.index, 0))), Math.max(0, count - 1))
  const order = leading
    ? 0
    : input.direction === 'center'
      ? Math.round(kevinHudCellOrder(index, Math.max(1, count), input.direction))
      : index
  const entranceDelay = leading
    ? 0
    : Math.min(
        KEVIN_HUD_REVEAL_MAX_DELAY_MS,
        KEVIN_HUD_REVEAL_BASE_DELAY_MS + order * KEVIN_HUD_REVEAL_STAGGER_MS
      )
  const y = input.direction === 'top' ? -12 : input.direction === 'bottom' ? 12 : 0

  return {
    x: Math.round(sign * amplitude),
    y,
    // The plate leads by a few frames; items then reveal in one tight wave.
    // The lead is intentionally short and the stagger caps after four steps so
    // a settled row is readable well before the entrance clock ends.
    delayMs: entranceDelay,
    // The exit starts at the exact time mirror of the entrance, so the slot
    // that opened first retracts last and the reversed wave ends opposite its
    // entrance, leading the frame's 360–600 ms contraction by only a little.
    exitDelayMs: Math.max(
      0,
      KEVIN_HUD_MOTION_TOTAL_MS - KEVIN_HUD_REVEAL_DURATION_MS - entranceDelay
    )
  }
}

export interface KevinHudTitleOriginInput {
  anchor: KevinHudAnchor
  direction: KevinHudDirection
  /** Settled surface width; the horizontal alignment reference. */
  surfaceWidth: number
  /** Final centre of the app name, ignoring animation transforms. */
  nameCenterX: number
  /** Final centre of the trailing launch status, ignoring transforms. */
  statusCenterX: number
}

export interface KevinHudTitleOriginPair {
  name: { x: number; y: number }
  status: { x: number; y: number }
}

/**
 * Resolve the two title labels independently so the static title wrapper never
 * has to choose one trajectory for both.
 *
 * Reusing the reveal rules means the centred name opens from the right of its
 * landing point and the trailing status opens from the left of its own; a
 * left-aligned title sends both left-to-right, a right-aligned title mirrors
 * that, and only the explicit top/bottom presets add vertical travel. The name
 * is pinned to the leading half and the status to the trailing half even when a
 * long name's measured box crosses the plate centre; without that, the
 * alignment rule would flip the name to the wrong side in a crowded title.
 */
export function kevinHudTitleOrigins(
  input: KevinHudTitleOriginInput
): KevinHudTitleOriginPair {
  const width = Math.max(1, finiteOr(input.surfaceWidth, 1))
  const middle = width / 2
  const resolve = (centerX: number): { x: number; y: number } => {
    const origin = kevinHudRevealOrigin({
      anchor: input.anchor,
      direction: input.direction,
      centerX,
      surfaceWidth: width,
      index: 0,
      count: 1,
      leading: false
    })
    return { x: origin.x, y: origin.y }
  }
  const sideCenter = (value: number, side: 'name' | 'status'): number => {
    const fallback = side === 'name' ? middle - 1 : middle + 1
    const center = finiteOr(value, fallback)
    if (input.anchor !== 'center') return center
    return side === 'name' ? Math.min(middle - 1, center) : Math.max(middle + 1, center)
  }
  return {
    name: resolve(sideCenter(input.nameCenterX, 'name')),
    status: resolve(sideCenter(input.statusCenterX, 'status'))
  }
}

/** Stagger from the centre for a centred reveal, left-to-right otherwise. */
export function kevinHudCellOrder(
  index: number,
  total: number,
  direction: KevinHudDirection
): number {
  if (direction !== 'center') return index
  const middle = (Math.max(1, total) - 1) / 2
  return Math.abs(index - middle)
}

/** Start-of-entrance height: shorter than the settled configured height. */
export function kevinHudOpenHeight(height: number): number {
  const settled = clamp(height, 24, 240, 48)
  return Math.max(16, Math.min(settled - 1, Math.round(settled * 0.68)))
}

/** Start-of-entrance corner, slightly tighter than the settled radius. */
export function kevinHudOpenRadius(radius: number): number {
  const settled = clamp(radius, 0, 64, 24)
  return Math.min(settled, Math.round(settled * 0.72))
}

/**
 * Resolve the plate geometry.
 *
 * The settled plate is always exactly the resolved height and radius. Callers
 * pass the height actually required by the content (which never falls below the
 * configured lower bound), so entrances grow from a shorter pose into the same
 * native host and exits contract by the exact reverse. There is no title peak,
 * no 1.5x height and no host-dependent geometry.
 */
export function kevinHudPlateGeometry(
  config: Pick<KevinHudConfig, 'height' | 'radius'>,
  options: KevinHudVisualOptions = {}
): KevinHudPlateGeometry {
  const phase = options.phase ?? 'monitor'
  const height = clamp(config.height, 24, 240, 48)
  const radius = clamp(config.radius, 0, 64, 24)
  const expandedPhase =
    phase === 'announce' || (phase === 'exit' && options.exitFrom === 'announce')
  const openHeight = kevinHudOpenHeight(height)
  const openRadius = kevinHudOpenRadius(radius)

  return {
    height,
    openHeight,
    radius,
    openRadius,
    baseHeight: height,
    expandedHeight: height,
    baseRadius: radius,
    expandedRadius: radius,
    expanded: expandedPhase
  }
}

/**
 * Build every dynamic style input for the HUD surface. The CSS file owns the
 * visual composition; this function only translates user configuration into
 * tokens, clamped values and a material fallback.
 */
export function resolveKevinHudVisual(
  config: KevinHudConfig,
  appGlass: GlassAppearance | null,
  options: KevinHudVisualOptions = {}
): KevinHudSurfaceVisual {
  const backgroundMode = config.backgroundMode
  const useAppGlass = backgroundMode === 'app'
  const useGradient = backgroundMode === 'gradient'
  const material =
    useAppGlass && isMaterial(appGlass?.material)
      ? appGlass.material
      : isMaterial(config.material)
        ? config.material
        : DEFAULT_MATERIAL
  const gradient = normalizeKevinHudGradient(config.gradient)

  const userFill =
    parseKevinHudHex(config.backgroundColor) ?? { r: 49, g: 47, b: 48, a: 1 }
  // The background group owns one opacity for the fill, material highlight and
  // backdrop. The foreground opacity is a separate group and never affects it.
  const backgroundOpacity = clamp(config.backgroundOpacity, 0, 1, 1)
  const foregroundOpacity = resolveKevinHudForegroundOpacity(config)
  const appFillColor = glassFallback(appGlass, material)

  const autoText = readableKevinHudText(
    useGradient ? averageGradientFill(gradient) : useAppGlass ? appFillColor : userFill,
    useAppGlass || useGradient ? 1 : backgroundOpacity
  )
  const explicitText = kevinHudHex(config.textColor)
  const textColor =
    config.textColor === 'auto'
      ? useAppGlass
        ? `var(--fg, ${autoText})`
        : autoText
      : (explicitText ?? autoText)
  const iconTint = kevinHudHex(config.iconColor)

  // Keep the local defensive clamps aligned with the shared HUD contract. The
  // user's height is a lower bound: the settled plate is the height actually
  // required by the current item typography, and the plate keyframes only start
  // shorter during an entrance before returning to this exact value. Legacy
  // per-item layout/type overrides are stripped before they can change this.
  const layoutConfig = kevinHudLayoutConfig(config)
  const widthBounds = resolveKevinHudWidthBounds(layoutConfig)
  const width = widthBounds.minWidth
  const contentPadding = resolveKevinHudContentPadding(layoutConfig)
  const itemGap = resolveKevinHudItemGap(layoutConfig)
  const contentMinHeight = measureKevinHudMinContentHeight(layoutConfig)
  // The CSS fallback for the surface outline is 1px '#A7AD48' (the sampled
  // reference edge). An explicit saved width/colour, including a legacy 0-px
  // border, still wins; missing shared defaults are read from the contract.
  const borderWidth = clamp(
    config.borderWidth,
    0,
    6,
    DEFAULT_KEVIN_HUD.borderWidth
  )
  const borderColor =
    kevinHudHex(config.borderColor) ?? DEFAULT_KEVIN_HUD.borderColor
  const fontScale = clamp(config.fontScale, 0.8, 1.25, 1)
  const textOffsetX = clamp(config.textOffsetX, -200, 200, 0)
  const textOffsetY = clamp(config.textOffsetY, -200, 200, 0)
  const iconOffsetX = clamp(config.iconOffsetX, -200, 200, 0)
  const iconOffsetY = clamp(config.iconOffsetY, -200, 200, 0)
  const ripple = kevinHudRipple(config.ripple)
  // The entrance grows into the actual settled lower bound: the configured
  // height raised by the current item typography. Starting from 68% of the
  // configured height while the host had already been raised would understate
  // the shorter pose and make the height jump feel unrelated to the content.
  // The dedicated host reports its real height through `config.height`, so
  // this same value is the on-screen plate there.
  const geometry = kevinHudPlateGeometry(
    { height: contentMinHeight, radius: config.radius },
    options
  )
  // Identity sizing follows the resolved settled height. It never expands for
  // an announcement, so the title cannot resize or overshoot.
  const compact = geometry.height < 36
  const tight = width < 280
  const iconSize = compact || tight ? 18 : 22
  const titleGap = tight ? 5 : 6
  // Launch identity order: play marker -> circular app icon -> app name. The
  // marker rides with the icon's absolute entrance wrapper, so the two can never
  // separate while the icon glides in from the centre.
  const launchMarkWidth = 7
  const launchMarkGap = 7
  // Relative to the identity block, whose left edge already sits on the
  // content's side padding.
  const iconSlotLeft = Math.round(launchMarkWidth + launchMarkGap + iconSize / 2)
  const titleLeft = Math.round(launchMarkWidth + launchMarkGap + iconSize + titleGap)
  const titleSize = compact ? 11 : tight ? 11.5 : 12.5
  const directionVars = kevinHudDirectionVars(config.direction)

  const fill = useAppGlass
    ? `var(--glass, ${rgbaFromHex(appFillColor, appFillColor.a)})`
    : useGradient
      ? 'transparent'
      : rgbaFromHex(userFill, userFill.a)
  // A zero background opacity must not leave a filtered glass ghost behind.
  // The backdrop lives inside the background group and is explicitly dropped
  // at zero, in addition to the group's own opacity.
  const backdrop =
    backgroundOpacity <= 0
      ? 'none'
      : useAppGlass
        ? `var(--glass-backdrop, ${materialFilter(material, appGlass)})`
        : backgroundMode === 'custom'
          ? materialFilter(material, null)
          : 'none'

  return {
    material,
    iconTint,
    gradient: useGradient ? gradient : null,
    vars: {
      '--khud-width': `${width}px`,
      '--khud-min-width': `${widthBounds.minWidth}px`,
      '--khud-max-width': `${widthBounds.maxWidth}px`,
      '--khud-content-min-height': `${contentMinHeight}px`,
      '--khud-height': `${geometry.height}px`,
      '--khud-open-height': `${geometry.openHeight}px`,
      // Both aliases intentionally equal the resolved settled height.
      '--khud-base-height': `${geometry.baseHeight}px`,
      '--khud-expanded-height': `${geometry.expandedHeight}px`,
      '--khud-radius': `${geometry.radius}px`,
      '--khud-open-radius': `${geometry.openRadius}px`,
      '--khud-base-radius': `${geometry.baseRadius}px`,
      '--khud-expanded-radius': `${geometry.expandedRadius}px`,
      '--khud-border-width': `${borderWidth}px`,
      '--khud-border-color': borderColor,
      // The background group (fill + material sheen + backdrop) and the
      // foreground group (content + border + ripple) each own one opacity. The
      // surface's existing entrance/exit opacity keyframes multiply over both,
      // so the reverse beat is unchanged.
      '--khud-background-opacity': backgroundOpacity.toFixed(3),
      '--khud-foreground-opacity': foregroundOpacity.toFixed(3),
      '--khud-fill': fill,
      '--khud-gradient': useGradient ? kevinHudGradientCss(gradient) : 'none',
      '--khud-backdrop': backdrop,
      '--khud-text': textColor,
      '--khud-icon-color': iconTint ?? 'currentColor',
      '--khud-font-scale': fontScale.toFixed(3),
      '--khud-text-x': `${textOffsetX}px`,
      '--khud-text-y': `${textOffsetY}px`,
      '--khud-icon-x': `${iconOffsetX}px`,
      '--khud-icon-y': `${iconOffsetY}px`,
      '--khud-motion-duration': `${KEVIN_HUD_MOTION_TOTAL_MS}ms`,
      '--khud-reveal-duration': `${KEVIN_HUD_REVEAL_DURATION_MS}ms`,
      '--khud-reveal-stagger': `${KEVIN_HUD_REVEAL_STAGGER_MS}ms`,
      '--khud-cell-min': `${KEVIN_HUD_MIN_CELL_PX}px`,
      '--khud-cell-gap': `${itemGap}px`,
      '--khud-item-gap': `${itemGap}px`,
      '--khud-content-pad-x': `${contentPadding.horizontal}px`,
      '--khud-content-pad-y': `${contentPadding.vertical}px`,
      '--khud-memory-min-width': `${KEVIN_HUD_MEMORY_READOUT_MIN_WIDTH}px`,
      // Settled plate height in a standalone preview. The dedicated HUD window
      // overrides this with 100% so a native host raised for a vertical/large
      // descriptor is filled instead of clipping the item.
      '--khud-plate-height': `${geometry.height}px`,
      // Historical consumers of the one-axis padding still get the horizontal
      // margin used by the reference capsule.
      '--khud-side-pad': `${contentPadding.horizontal}px`,
      '--khud-icon-size': `${iconSize}px`,
      '--khud-icon-slot-left': `${iconSlotLeft}px`,
      '--khud-launch-mark-width': `${launchMarkWidth}px`,
      '--khud-launch-mark-gap': `${launchMarkGap}px`,
      '--khud-status-size': `${KEVIN_HUD_ANNOUNCE_STATUS_SIZE}px`,
      '--khud-status-tracking': `${KEVIN_HUD_ANNOUNCE_STATUS_TRACKING}em`,
      '--khud-status-gap': `${KEVIN_HUD_ANNOUNCE_STATUS_GAP}px`,
      '--khud-title-left': `${titleLeft}px`,
      '--khud-title-size': `${titleSize}px`,
      '--khud-ripple-strength': ripple.strength.toFixed(3),
      '--khud-ripple-peak-opacity': ripple.peakOpacity.toFixed(3),
      '--khud-ripple-end-scale': ripple.endScale.toFixed(3),
      ...directionVars
    }
  }
}

/** Keep an app title useful even when the frame's name is malformed. */
export function kevinHudAppName(name: string | null | undefined): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  return trimmed || 'KEVIN'
}
