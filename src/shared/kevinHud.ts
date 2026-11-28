import { MATERIAL_DEFAULTS, type GlassAppearance, type GlassMaterial } from './types'
import {
  DEFAULT_KEVIN_HUD_GRADIENT,
  isKevinHudGradient,
  normalizeKevinHudGradient,
  type KevinHudGradient
} from './kevinHudBackground'

/**
 * Shared contract for the Kevin HUD overlay.
 *
 * Scope boundary: this module defines the persisted per-app settings, the
 * renderer frame shape, and defensive normalization. It deliberately does not
 * create windows, sample metrics, register hotkeys, or talk over IPC. The HUD
 * settings live inside the normal `config.json` app entry, so existing
 * export/import, backup and atomic-write paths keep owning persistence.
 *
 * A hotkey is stored in Electron's native globalShortcut accelerator syntax
 * when present. It is intentionally not parsed here: only the IPC layer that
 * registers a shortcut has the authority to reject unsupported accelerators.
 */
export const KEVIN_HUD_METRICS = [
  'appName',
  'sessionTime',
  'totalTime',
  'fps',
  'gpu',
  'cpu',
  'memory',
  'download',
  'upload',
  'clock'
] as const

export type KevinHudMetric = (typeof KEVIN_HUD_METRICS)[number]

export type KevinHudItemOrientation = 'horizontal' | 'vertical'
export type KevinHudItemDescription = 'text' | 'icon'
/** Inline alignment of a descriptor or value inside its measured item slot. */
export type KevinHudItemAlign = 'left' | 'center' | 'right'

/**
 * Presentation contract for one settled HUD item.
 *
 * `description` is deliberately separate from the value: `text` renders the
 * short uppercase eyebrow (for example `FPS`), `icon` reserves a square icon
 * slot with the same measured footprint. The canonical `appName` item is the
 * former icon/name pair merged into one regular value: its description is
 * always the real app icon and its value is always the app's actual name.
 */
export interface KevinHudItemStyle {
  orientation: KevinHudItemOrientation
  description: KevinHudItemDescription
  /**
   * Minimum space between the descriptor and its value. It applies on the
   * horizontal axis for a row and on the vertical axis for a stacked item, so
   * the two blocks never overlap. It is a minimum, not an exact gap: alignment
   * may add space inside a wider measured cell.
   */
  gap: number
  /**
   * Minimum total width of one item slot in DIP (0…1600). The measured content
   * may still make an item wider; a narrower host grows or scrolls instead of
   * clipping the content. It never constrains the content's own minimum width.
   */
  minWidth: number
  /** Inline alignment of the descriptor; defaults to `left`. */
  descriptionAlign: KevinHudItemAlign
  /** Inline alignment of the value; defaults to `right`. */
  valueAlign: KevinHudItemAlign
  /** Descriptor font size in CSS pixels before `fontScale`. */
  descriptionSize: number
  /** Value font size in CSS pixels before `fontScale`. */
  valueSize: number
  descriptionBold: boolean
  valueBold: boolean
  /**
   * Six-digit hex descriptor colour, or `null` to follow the readable
   * reference colour (a muted light white over the dark capsule). Colours do
   * not participate in sizing.
   */
  descriptionColor: string | null
  /**
   * Six-digit hex value colour, or `null` to follow the readable reference
   * colour (white). Colours do not participate in sizing.
   */
  valueColor: string | null
}

/**
 * A metric may override the inner gap, its minimum width, the two alignments
 * and the two item colours. Orientation, descriptor form, type size and weight
 * are always the app-wide `itemStyle`; this keeps a saved HUD internally
 * consistent.
 */
export type KevinHudItemStyleOverride = Partial<
  Pick<
    KevinHudItemStyle,
    | 'gap'
    | 'minWidth'
    | 'descriptionAlign'
    | 'valueAlign'
    | 'descriptionColor'
    | 'valueColor'
  >
>

/**
 * The dedicated memory instrument is the default presentation only while the
 * item keeps the reference descriptor-left / value-right alignment. Any
 * customized alignment opts into the ordinary measured item layout, where the
 * shared sizing and row overflow rules fully control the result.
 */
export function usesKevinHudMemoryReadout(
  style:
    | Pick<KevinHudItemStyle, 'descriptionAlign' | 'valueAlign'>
    | null
    | undefined
): boolean {
  return (style?.descriptionAlign ?? 'left') === 'left' &&
    (style?.valueAlign ?? 'right') === 'right'
}

/** Sparse per-metric overrides on top of `KevinHudConfig.itemStyle`. */
export type KevinHudItemStyles = Partial<
  Record<KevinHudMetric, KevinHudItemStyleOverride>
>

export type KevinHudDirection = 'center' | 'left' | 'right' | 'top' | 'bottom'
export type KevinHudAnchor = 'left' | 'center' | 'right'
/**
 * `gradient` paints the persisted `gradient`; `solid` keeps using the editable
 * `backgroundColor`. The full gradient is stored in every mode so switching
 * back and forth never discards the user's stops.
 */
export type KevinHudBackgroundMode = 'solid' | 'app' | 'custom' | 'gradient'
export type KevinHudMonitor = 'primary' | 'game'
/**
 * How the native window chooses its screen position. `preset` means the
 * built-in top-centre placement on the primary display; `custom` uses the
 * persisted `anchor` / `x` / `y` percentages.
 */
export type KevinHudPositionMode = 'preset' | 'custom'

/** Per-app settings for the Kevin HUD overlay. */
export interface KevinHudConfig {
  enabled: boolean
  alwaysVisible: boolean
  /**
   * Whether the real launcher window is absorbed into the HUD when a launch is
   * announced. Historical configs have no value and keep the previous
   * behavior (`true`); `false` lets the shell stay visible.
   */
  absorbLauncher: boolean
  /** Transient announcement duration in seconds (3…10). */
  displaySeconds: number
  /** Metric sampling interval in seconds (0.5…5; 0.5 / 1 / 2 are the common choices). */
  sampleSeconds: number
  direction: KevinHudDirection
  /** Entrance bounce amount (0…0.5). */
  bounce: number
  /** Ripple strength (0…2). */
  ripple: number
  /**
   * Built-in top-centre preset or the manual percentages below. A missing value
   * in historical configs is inferred from the old position fields.
   */
  positionMode: KevinHudPositionMode
  anchor: KevinHudAnchor
  /** Horizontal position as a screen percentage (0…100). */
  x: number
  /** Vertical position as a screen percentage (0…100). */
  y: number
  /** Fixed width, or the minimum width when `autoWidth` is enabled. */
  width: number
  /**
   * Hard upper width bound. `width` remains the manual/minimum width for
   * historical configs, so a legacy fixed width resolves to `width === maxWidth`
   * when no explicit `maxWidth` was saved.
   */
  maxWidth: number
  /** Height used by both the settled HUD and the launch title. */
  height: number
  radius: number
  /** Border width in pixels (0…6). */
  borderWidth: number
  borderColor: string
  backgroundMode: KevinHudBackgroundMode
  /**
   * Persisted background gradient. It is only painted when `backgroundMode` is
   * `gradient`; the complete value is retained in every mode so switching
   * backgrounds stays lossless.
   */
  gradient: KevinHudGradient
  /** Existing launcher glass material, used when the renderer opts into glass. */
  material: GlassMaterial
  backgroundColor: string
  /**
   * Foreground opacity (0…1): text, artwork, glyphs, progress ring, border,
   * ripple and decorations. It is independent from `backgroundOpacity` and
   * never fades the plate fill or backdrop.
   *
   * The intermediate `opacity` field is accepted on read as a fallback for
   * existing data, but it is never written back: `foregroundOpacity` is the
   * only canonical foreground control.
   */
  foregroundOpacity: number
  /** Background fill/material/backdrop opacity (0…1). */
  backgroundOpacity: number
  /** `auto` follows the contrast rule; otherwise a six-digit hex colour. */
  textColor: 'auto' | string
  /** Six-digit hex tint for the app icon; `null` keeps the original colours. */
  iconColor: string | null
  textOffsetX: number
  textOffsetY: number
  iconOffsetX: number
  iconOffsetY: number
  /** Text scale (0.8…1.25). */
  fontScale: number
  /** Space between two selected items in the settled row. */
  itemGap: number
  /**
   * Horizontal and vertical content padding around the item row. A single
   * value keeps the persisted contract compact; the renderer applies it on the
   * inline axis and the native height reserves it on both vertical edges.
   */
  contentPadding: number
  /** Default presentation for every value item. */
  itemStyle: KevinHudItemStyle
  /** Optional per-metric overrides; missing fields fall back to `itemStyle`. */
  itemStyles: KevinHudItemStyles
  monitor: KevinHudMonitor
  /**
   * Legacy grow switch. `width` is always the manual/minimum width now: a
   * historical `false` without `maxWidth` resolves `maxWidth === width` (fully
   * fixed), while `true` grows to `maxWidth`. Overflow always scrolls inside
   * the HUD instead of wrapping the one-row layout.
   */
  autoWidth: boolean
  restoreLauncher: boolean
  /** Electron globalShortcut accelerator string, or `null` when unbound. */
  hotkey: string | null
  /**
   * Enabled settled metrics in display order; never contains duplicates. The
   * launch title shows the app icon and name independently of this list.
   */
  metrics: KevinHudMetric[]
}

/** One immutable state update rendered by the HUD overlay. */
export interface KevinHudFrame {
  phase: 'announce' | 'monitor' | 'exit'
  config: KevinHudConfig
  appName: string
  iconUrl: string | null
  /** Legacy single launcher font. Older producers only set this field. */
  fontFamily: string | null
  /**
   * Optional independent font families for mixed English/digits and Chinese
   * text. When either field is absent, renderers fall back to `fontFamily`.
   */
  fontFamilyEn?: string | null
  fontFamilyZh?: string | null
  /** The app's existing launcher glass appearance, when one is available. */
  appGlass: GlassAppearance | null
  /** Formatted metric strings; `null` means the metric is unavailable. */
  values: Partial<Record<KevinHudMetric, string | null>>
}

/**
 * The one canonical set of persisted numeric ranges. Settings controls, the
 * write guard and the shared sizing helpers all resolve through this object, so
 * a value selected in the UI can never shrink or clamp again at runtime.
 */
export const KEVIN_HUD_LIMITS = Object.freeze({
  displaySeconds: [3, 10],
  sampleSeconds: [0.5, 5],
  bounce: [0, 0.5],
  ripple: [0, 2],
  x: [0, 100],
  y: [0, 100],
  width: [120, 1600],
  maxWidth: [120, 1600],
  height: [24, 240],
  radius: [0, 64],
  borderWidth: [0, 6],
  textOffsetX: [-200, 200],
  textOffsetY: [-200, 200],
  iconOffsetX: [-200, 200],
  iconOffsetY: [-200, 200],
  fontScale: [0.8, 1.25],
  itemGap: [0, 48],
  contentPadding: [0, 32],
  foregroundOpacity: [0, 1],
  backgroundOpacity: [0, 1]
} as const)

/**
 * Per-item layout ranges. These are deliberately part of the persisted
 * contract, not a separate sizing-only opinion: itemGap is the row gap
 * (`KEVIN_HUD_LIMITS.itemGap`), while `gap` is the minimum description/value
 * gap inside one cell and `minWidth` is that cell's lower width bound.
 */
export const KEVIN_HUD_ITEM_STYLE_LIMITS = Object.freeze({
  gap: [0, 24],
  /** Same range as the HUD width so one item cannot exceed a legal capsule. */
  minWidth: [0, KEVIN_HUD_LIMITS.width[1]],
  descriptionSize: [6, 24],
  valueSize: [8, 32]
} as const)

const HUD_LIMITS = KEVIN_HUD_LIMITS
const ITEM_STYLE_LIMITS = KEVIN_HUD_ITEM_STYLE_LIMITS

const DIRECTIONS = ['center', 'left', 'right', 'top', 'bottom'] as const satisfies readonly KevinHudDirection[]
const ANCHORS = ['left', 'center', 'right'] as const satisfies readonly KevinHudAnchor[]
const BACKGROUND_MODES = ['solid', 'app', 'custom', 'gradient'] as const satisfies readonly KevinHudBackgroundMode[]
const MONITORS = ['primary', 'game'] as const satisfies readonly KevinHudMonitor[]
const POSITION_MODES = ['preset', 'custom'] as const satisfies readonly KevinHudPositionMode[]
const ITEM_ORIENTATIONS = ['horizontal', 'vertical'] as const satisfies readonly KevinHudItemOrientation[]
const ITEM_DESCRIPTIONS = ['text', 'icon'] as const satisfies readonly KevinHudItemDescription[]
const ITEM_ALIGNS = ['left', 'center', 'right'] as const satisfies readonly KevinHudItemAlign[]

const ITEM_STYLE_KEYS = new Set([
  'orientation',
  'description',
  'gap',
  'minWidth',
  'descriptionAlign',
  'valueAlign',
  'descriptionSize',
  'valueSize',
  'descriptionBold',
  'valueBold',
  'descriptionColor',
  'valueColor'
])

/**
 * The only per-metric fields that may diverge from the app-wide `itemStyle`.
 * Historical beta itemStyles also carried layout/type/weight fields; those are
 * ignored on read instead of overriding the unified style. Orientation,
 * descriptor form, type size and weight remain unified.
 */
const ITEM_STYLE_OVERRIDE_KEYS = new Set([
  'gap',
  'minWidth',
  'descriptionAlign',
  'valueAlign',
  'descriptionColor',
  'valueColor'
])

const MAX_HOTKEY_LENGTH = 128

const HEX_COLOR = /^#[\da-f]{6}$/i
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const METRIC_SET = new Set<string>(KEVIN_HUD_METRICS)
const MATERIAL_SET = new Set<string>(Object.keys(MATERIAL_DEFAULTS))
/**
 * Read-only aliases from early beta configurations. `appIcon` is no longer a
 * selectable or persisted metric: the canonical `appName` item now draws the
 * real app icon as its descriptor. Aliases are resolved only while reading
 * saved data; the write guard remains strict.
 */
const METRIC_ALIASES = new Map<string, KevinHudMetric>([['appIcon', 'appName']])

/**
 * Metrics shown for a new app: the three performance gauges. The launch title
 * always shows the app icon and name on its own, while the merged appName item
 * remains selectable for the settled HUD. Every saved selection, including an
 * explicit empty list, is preserved by normalization.
 */
const DEFAULT_METRICS: readonly KevinHudMetric[] = ['fps', 'gpu', 'cpu']

/**
 * Default typography for the 448 x 48 reference capsule: a 12 px bold text
 * descriptor, a 14 px bold tabular value and a 5 px minimum descriptor/value
 * gap. A `null` colour follows the renderer's readable reference colour; values
 * are white and descriptions use the muted light-white eyebrow.
 *
 * The descriptor starts on the left and the value ends on the right. Those two
 * reference alignments are also what allows the dedicated memory instrument;
 * any customized alignment switches memory to the ordinary measured layout.
 */
export const DEFAULT_KEVIN_HUD_ITEM_STYLE: KevinHudItemStyle = {
  orientation: 'horizontal',
  description: 'text',
  gap: 5,
  minWidth: 0,
  descriptionAlign: 'left',
  valueAlign: 'right',
  descriptionSize: 12,
  valueSize: 14,
  descriptionBold: true,
  valueBold: true,
  descriptionColor: null,
  valueColor: null
}

/**
 * Safe defaults applied to new apps and to every malformed/missing HUD field.
 *
 * The reference capsule is always visible, top-center on the primary display,
 * 448 x 48 DIP, radius 24, fully opaque #312F30 with a subtle 2 px #A7AD48
 * border sampled from the right-hand memory gauge and a quiet charcoal gradient
 * fill. It is deliberately fixed-width: `width` is the same 448 DIPs used by
 * both the native host and the renderer, while a user can still replace it with
 * any supported min/max configuration.
 */
export const DEFAULT_KEVIN_HUD: KevinHudConfig = {
  enabled: true,
  alwaysVisible: true,
  absorbLauncher: true,
  displaySeconds: 6,
  sampleSeconds: 1,
  direction: 'center',
  bounce: 0.275,
  ripple: 1,
  positionMode: 'preset',
  anchor: 'center',
  x: 50,
  y: 3,
  width: 448,
  maxWidth: 448,
  height: 48,
  radius: 24,
  borderWidth: 2,
  borderColor: '#A7AD48',
  backgroundMode: 'gradient',
  gradient: normalizeKevinHudGradient(DEFAULT_KEVIN_HUD_GRADIENT),
  material: 'blur',
  backgroundColor: '#312F30',
  foregroundOpacity: 1,
  backgroundOpacity: 1,
  textColor: '#FFFFFF',
  iconColor: null,
  textOffsetX: 0,
  textOffsetY: 0,
  iconOffsetX: 0,
  iconOffsetY: 0,
  fontScale: 1,
  itemGap: 8,
  contentPadding: 12,
  itemStyle: { ...DEFAULT_KEVIN_HUD_ITEM_STYLE },
  itemStyles: {},
  monitor: 'primary',
  autoWidth: false,
  restoreLauncher: false,
  hotkey: null,
  metrics: [...DEFAULT_METRICS]
}

/**
 * The complete, untouched beta default preset. It is used only to upgrade a
 * provably complete previous build default to the current reference capsule.
 * Any difference (including a per-metric override) is a customization and is
 * left intact; the settings reset action owns the user-initiated upgrade.
 *
 * These matching constants intentionally keep their historical values
 * (notably the invisible 0 px #656363 border and the old item style) so that
 * only a truly untouched preset is promoted. A partial saved config with an
 * explicit 0 px border or a custom border colour therefore keeps that choice.
 */
const LEGACY_REFERENCE_DEFAULT = {
  enabled: true,
  alwaysVisible: false,
  displaySeconds: 6,
  sampleSeconds: 1,
  direction: 'center',
  bounce: 0.275,
  ripple: 1,
  positionMode: 'preset',
  anchor: 'center',
  x: 50,
  y: 3,
  width: 448,
  maxWidth: 1600,
  height: 48,
  radius: 24,
  borderWidth: 0,
  borderColor: '#656363',
  backgroundMode: 'solid',
  material: 'blur',
  backgroundColor: '#312F30',
  backgroundOpacity: 1,
  textColor: '#FFFFFF',
  iconColor: null,
  textOffsetX: 0,
  textOffsetY: 0,
  iconOffsetX: 0,
  iconOffsetY: 0,
  fontScale: 1,
  itemGap: 8,
  contentPadding: 12,
  itemStyle: {
    orientation: 'horizontal',
    description: 'text',
    gap: 5,
    descriptionSize: 8.5,
    valueSize: 12,
    descriptionBold: true,
    valueBold: true
  },
  itemStyles: {},
  monitor: 'primary',
  autoWidth: true,
  restoreLauncher: false,
  hotkey: null,
  metrics: ['memory']
} as const

/**
 * Historical auto-width configs without an explicit `maxWidth` keep their
 * broad grow cap. The new reference default is fixed (448/448), but a user's
 * previously chosen grow mode remains compatible.
 */
export const KEVIN_HUD_LEGACY_AUTO_MAX_WIDTH = 1600

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isMetric = (value: unknown): value is KevinHudMetric =>
  typeof value === 'string' && METRIC_SET.has(value)

/** Resolve a saved id to its canonical metric, accepting read-only aliases. */
const canonicalMetric = (value: unknown): KevinHudMetric | null => {
  if (typeof value !== 'string') return null
  if (METRIC_SET.has(value)) return value as KevinHudMetric
  return METRIC_ALIASES.get(value) ?? null
}

/**
 * Normalize a saved metric list. Aliases map onto their canonical metric and
 * duplicates are removed while preserving the first appearance. A non-array
 * value falls back to the default profile; an explicit empty array stays empty.
 */
function normalizeMetrics(value: unknown): KevinHudMetric[] {
  if (!Array.isArray(value)) return [...DEFAULT_METRICS]
  const seen = new Set<KevinHudMetric>()
  const result: KevinHudMetric[] = []
  for (const entry of value) {
    const metric = canonicalMetric(entry)
    if (!metric || seen.has(metric)) continue
    seen.add(metric)
    result.push(metric)
  }
  return result
}

const isMaterial = (value: unknown): value is GlassMaterial =>
  typeof value === 'string' && MATERIAL_SET.has(value)

const isHexColor = (value: unknown): value is string =>
  typeof value === 'string' && HEX_COLOR.test(value.trim())

const pickBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const isEnum = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)

const pickEnum = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  isEnum(value, allowed) ? value : fallback

const pickNumber = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback

const pickSized = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(max, Math.max(min, value))
    : fallback

const pickNonNegative = (value: unknown, fallback: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, max)
    : fallback

const pickColor = (value: unknown, fallback: string): string =>
  isHexColor(value) ? value.trim() : fallback

/**
 * Read the canonical foreground opacity, falling back to the intermediate
 * `opacity` field that briefly existed in this work. The fallback is read-only:
 * normalization never emits `opacity` again. A finite canonical number always
 * wins, even when out of range, so clamping stays the normalizer's job.
 */
const foregroundOpacitySource = (source: Record<string, unknown>): unknown =>
  typeof source.foregroundOpacity === 'number' && Number.isFinite(source.foregroundOpacity)
    ? source.foregroundOpacity
    : source.opacity

const pickHotkey = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const hotkey = value.trim()
  if (!hotkey || hotkey.length > MAX_HOTKEY_LENGTH || CONTROL_CHARACTER.test(hotkey)) return null
  return hotkey
}

const isColorOrNull = (value: unknown): value is string | null =>
  value === null || isHexColor(value)

const isPartialItemStyle = (value: unknown): value is Partial<KevinHudItemStyle> => {
  if (!isRecord(value)) return false
  return Object.entries(value).every(([key, field]) => {
    if (!ITEM_STYLE_KEYS.has(key)) return false
    switch (key) {
      case 'orientation':
        return isEnum(field, ITEM_ORIENTATIONS)
      case 'description':
        return isEnum(field, ITEM_DESCRIPTIONS)
      case 'descriptionAlign':
      case 'valueAlign':
        return isEnum(field, ITEM_ALIGNS)
      case 'descriptionBold':
      case 'valueBold':
        return typeof field === 'boolean'
      case 'descriptionColor':
      case 'valueColor':
        return isColorOrNull(field)
      case 'gap':
        return typeof field === 'number' && Number.isFinite(field) &&
          field >= ITEM_STYLE_LIMITS.gap[0] && field <= ITEM_STYLE_LIMITS.gap[1]
      case 'minWidth':
        return typeof field === 'number' && Number.isFinite(field) &&
          field >= ITEM_STYLE_LIMITS.minWidth[0] &&
          field <= ITEM_STYLE_LIMITS.minWidth[1]
      case 'descriptionSize':
        return typeof field === 'number' && Number.isFinite(field) &&
          field >= ITEM_STYLE_LIMITS.descriptionSize[0] &&
          field <= ITEM_STYLE_LIMITS.descriptionSize[1]
      case 'valueSize':
        return typeof field === 'number' && Number.isFinite(field) &&
          field >= ITEM_STYLE_LIMITS.valueSize[0] &&
          field <= ITEM_STYLE_LIMITS.valueSize[1]
      default:
        return false
    }
  })
}

/** A per-metric override may only contain the six allowlisted fields. */
const isItemStyleOverride = (value: unknown): value is KevinHudItemStyleOverride => {
  if (!isRecord(value)) return false
  return Object.entries(value).every(([key, field]) => {
    if (!ITEM_STYLE_OVERRIDE_KEYS.has(key)) return false
    if (key === 'gap') {
      return typeof field === 'number' && Number.isFinite(field) &&
        field >= ITEM_STYLE_LIMITS.gap[0] && field <= ITEM_STYLE_LIMITS.gap[1]
    }
    if (key === 'minWidth') {
      return typeof field === 'number' && Number.isFinite(field) &&
        field >= ITEM_STYLE_LIMITS.minWidth[0] &&
        field <= ITEM_STYLE_LIMITS.minWidth[1]
    }
    if (key === 'descriptionAlign' || key === 'valueAlign') {
      return isEnum(field, ITEM_ALIGNS)
    }
    return isColorOrNull(field)
  })
}

/** Keep only recognized, valid properties of a full item-style patch. */
function normalizePartialItemStyle(value: unknown): Partial<KevinHudItemStyle> {
  if (!isRecord(value)) return {}
  const result: Partial<KevinHudItemStyle> = {}
  if (isEnum(value.orientation, ITEM_ORIENTATIONS)) result.orientation = value.orientation
  if (isEnum(value.description, ITEM_DESCRIPTIONS)) result.description = value.description
  if (typeof value.gap === 'number' && Number.isFinite(value.gap)) {
    result.gap = pickNumber(value.gap, DEFAULT_KEVIN_HUD_ITEM_STYLE.gap, ...ITEM_STYLE_LIMITS.gap)
  }
  if (typeof value.minWidth === 'number' && Number.isFinite(value.minWidth)) {
    result.minWidth = pickNumber(
      value.minWidth,
      DEFAULT_KEVIN_HUD_ITEM_STYLE.minWidth,
      ...ITEM_STYLE_LIMITS.minWidth
    )
  }
  if (isEnum(value.descriptionAlign, ITEM_ALIGNS)) {
    result.descriptionAlign = value.descriptionAlign
  }
  if (isEnum(value.valueAlign, ITEM_ALIGNS)) {
    result.valueAlign = value.valueAlign
  }
  if (typeof value.descriptionSize === 'number' && Number.isFinite(value.descriptionSize)) {
    result.descriptionSize = pickNumber(
      value.descriptionSize,
      DEFAULT_KEVIN_HUD_ITEM_STYLE.descriptionSize,
      ...ITEM_STYLE_LIMITS.descriptionSize
    )
  }
  if (typeof value.valueSize === 'number' && Number.isFinite(value.valueSize)) {
    result.valueSize = pickNumber(
      value.valueSize,
      DEFAULT_KEVIN_HUD_ITEM_STYLE.valueSize,
      ...ITEM_STYLE_LIMITS.valueSize
    )
  }
  if (typeof value.descriptionBold === 'boolean') result.descriptionBold = value.descriptionBold
  if (typeof value.valueBold === 'boolean') result.valueBold = value.valueBold
  if (Object.hasOwn(value, 'descriptionColor') && isColorOrNull(value.descriptionColor)) {
    result.descriptionColor =
      value.descriptionColor === null ? null : value.descriptionColor.trim()
  }
  if (Object.hasOwn(value, 'valueColor') && isColorOrNull(value.valueColor)) {
    result.valueColor = value.valueColor === null ? null : value.valueColor.trim()
  }
  return result
}

/** Keep only the metric's allowlisted gap/min-width/alignment/colour overrides. */
function normalizeItemStyleOverride(value: unknown): KevinHudItemStyleOverride {
  if (!isRecord(value)) return {}
  const result: KevinHudItemStyleOverride = {}
  if (typeof value.gap === 'number' && Number.isFinite(value.gap)) {
    result.gap = pickNumber(value.gap, DEFAULT_KEVIN_HUD_ITEM_STYLE.gap, ...ITEM_STYLE_LIMITS.gap)
  }
  if (typeof value.minWidth === 'number' && Number.isFinite(value.minWidth)) {
    result.minWidth = pickNumber(
      value.minWidth,
      DEFAULT_KEVIN_HUD_ITEM_STYLE.minWidth,
      ...ITEM_STYLE_LIMITS.minWidth
    )
  }
  if (isEnum(value.descriptionAlign, ITEM_ALIGNS)) {
    result.descriptionAlign = value.descriptionAlign
  }
  if (isEnum(value.valueAlign, ITEM_ALIGNS)) {
    result.valueAlign = value.valueAlign
  }
  if (Object.hasOwn(value, 'descriptionColor') && isColorOrNull(value.descriptionColor)) {
    result.descriptionColor =
      value.descriptionColor === null ? null : value.descriptionColor.trim()
  }
  if (Object.hasOwn(value, 'valueColor') && isColorOrNull(value.valueColor)) {
    result.valueColor = value.valueColor === null ? null : value.valueColor.trim()
  }
  return result
}

/** Resolve a complete global item style from a full, partial or missing value. */
export function normalizeKevinHudItemStyle(value: unknown): KevinHudItemStyle {
  return {
    ...DEFAULT_KEVIN_HUD_ITEM_STYLE,
    ...normalizePartialItemStyle(value)
  }
}

/**
 * Resolve sparse per-metric overrides. Historical beta entries may contain
 * orientation/description/type-size/bold fields; those are deliberately
 * dropped here so the app-wide `itemStyle` stays authoritative.
 *
 * Early beta also stored a separate `appIcon` override. It is folded into the
 * canonical `appName` override field-by-field. A canonical field always wins;
 * the alias only fills the fields the canonical entry did not save. Invalid
 * alias fields are ignored instead of making the whole HUD unreadable.
 */
export function normalizeKevinHudItemStyles(value: unknown): KevinHudItemStyles {
  if (!isRecord(value)) return {}
  const result: KevinHudItemStyles = {}
  for (const [metric, style] of Object.entries(value)) {
    const canonical = canonicalMetric(metric)
    if (!canonical) continue
    const normalized = normalizeItemStyleOverride(style)
    if (Object.keys(normalized).length === 0) continue
    const existing = result[canonical]
    result[canonical] = canonical === metric
      // A canonical entry overlays any alias already read.
      ? { ...existing, ...normalized }
      // An alias sits under a canonical entry read before it.
      : { ...normalized, ...existing }
  }
  return result
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }
    return left.every((entry, index) => isDeepEqual(entry, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && isDeepEqual(left[key], right[key]))
}

/**
 * True only when the saved object is a complete, untouched previous-build
 * default. A partial object, one changed field, or an old per-metric override
 * is customization and must not be rewritten by a blind migration.
 */
function isLegacyReferenceDefault(source: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(LEGACY_REFERENCE_DEFAULT)) {
    if (!Object.hasOwn(source, key) || !isDeepEqual(source[key], expected)) return false
  }
  // Fields introduced together with this reference must be absent or default.
  if (Object.hasOwn(source, 'absorbLauncher') && source.absorbLauncher !== true) return false

  // The intermediate whole-overlay opacity is the read-time fallback for the
  // canonical foreground opacity. Any explicit non-default foreground choice
  // is customization and must not be silently replaced by the new preset.
  const foregroundOpacity = foregroundOpacitySource(source)
  if (foregroundOpacity !== undefined && foregroundOpacity !== 1) return false

  // The previous default had no gradient at all. An explicit custom gradient is
  // a background customization even when every legacy field still matches.
  if (Object.hasOwn(source, 'gradient') &&
    !isDeepEqual(source.gradient, DEFAULT_KEVIN_HUD.gradient)) {
    return false
  }
  return true
}

function referenceDefaultConfig(): KevinHudConfig {
  return {
    ...DEFAULT_KEVIN_HUD,
    gradient: normalizeKevinHudGradient(DEFAULT_KEVIN_HUD.gradient),
    itemStyle: { ...DEFAULT_KEVIN_HUD_ITEM_STYLE },
    itemStyles: {},
    metrics: [...DEFAULT_METRICS]
  }
}

/**
 * Older configs have no `positionMode`. Only the historical default position
 * (horizontal 50 %, vertical 3 %, centre anchor) is promoted to the preset;
 * every explicit non-default coordinate stays manually positioned. Explicitly
 * invalid modes are treated as legacy data too.
 */
function inferPositionMode(source: Record<string, unknown>): KevinHudPositionMode {
  if (isEnum(source.positionMode, POSITION_MODES)) return source.positionMode
  const anchor = pickEnum(source.anchor, ANCHORS, DEFAULT_KEVIN_HUD.anchor)
  const x = pickNumber(source.x, DEFAULT_KEVIN_HUD.x, ...HUD_LIMITS.x)
  const y = pickNumber(source.y, DEFAULT_KEVIN_HUD.y, ...HUD_LIMITS.y)
  return x === DEFAULT_KEVIN_HUD.x &&
    y === DEFAULT_KEVIN_HUD.y &&
    anchor === DEFAULT_KEVIN_HUD.anchor
    ? 'preset'
    : 'custom'
}

/**
 * Return a complete, safe HUD configuration. Unknown fields are ignored; invalid
 * values fall back to `DEFAULT_KEVIN_HUD`; finite numbers are clamped to their
 * supported ranges. The input is never mutated.
 */
export function normalizeKevinHudConfig(value: unknown): KevinHudConfig {
  const source = isRecord(value) ? value : {}

  // Upgrading the previous build's untouched preset is safe because every
  // persisted field must match exactly. A narrowed or partial config keeps its
  // own values; the settings "restore defaults" action remains the explicit
  // route for customized users.
  if (isLegacyReferenceDefault(source)) return referenceDefaultConfig()

  const textColor = source.textColor === 'auto'
    ? 'auto'
    : pickColor(source.textColor, DEFAULT_KEVIN_HUD.textColor)
  const metrics = normalizeMetrics(source.metrics)
  const width = pickSized(source.width, DEFAULT_KEVIN_HUD.width, ...HUD_LIMITS.width)
  const autoWidth = pickBoolean(source.autoWidth, DEFAULT_KEVIN_HUD.autoWidth)
  // Backwards compatibility: historical fixed-width configs have no maxWidth.
  // Resolve those to min === max so their persisted width is untouched. An old
  // auto-width config without an explicit cap keeps the broad grow range.
  const maxWidth = Math.max(
    width,
    pickSized(
      source.maxWidth,
      autoWidth ? KEVIN_HUD_LEGACY_AUTO_MAX_WIDTH : width,
      ...HUD_LIMITS.maxWidth
    )
  )
  const itemStyle = normalizeKevinHudItemStyle(source.itemStyle)
  const itemStyles = normalizeKevinHudItemStyles(source.itemStyles)
  const gradient = normalizeKevinHudGradient(source.gradient)

  return {
    enabled: pickBoolean(source.enabled, DEFAULT_KEVIN_HUD.enabled),
    alwaysVisible: pickBoolean(source.alwaysVisible, DEFAULT_KEVIN_HUD.alwaysVisible),
    absorbLauncher: pickBoolean(source.absorbLauncher, DEFAULT_KEVIN_HUD.absorbLauncher),
    displaySeconds: pickNumber(
      source.displaySeconds,
      DEFAULT_KEVIN_HUD.displaySeconds,
      ...HUD_LIMITS.displaySeconds
    ),
    sampleSeconds: pickNumber(
      source.sampleSeconds,
      DEFAULT_KEVIN_HUD.sampleSeconds,
      ...HUD_LIMITS.sampleSeconds
    ),
    direction: pickEnum(source.direction, DIRECTIONS, DEFAULT_KEVIN_HUD.direction),
    bounce: pickNumber(source.bounce, DEFAULT_KEVIN_HUD.bounce, ...HUD_LIMITS.bounce),
    ripple: pickNumber(source.ripple, DEFAULT_KEVIN_HUD.ripple, ...HUD_LIMITS.ripple),
    positionMode: inferPositionMode(source),
    anchor: pickEnum(source.anchor, ANCHORS, DEFAULT_KEVIN_HUD.anchor),
    x: pickNumber(source.x, DEFAULT_KEVIN_HUD.x, ...HUD_LIMITS.x),
    y: pickNumber(source.y, DEFAULT_KEVIN_HUD.y, ...HUD_LIMITS.y),
    width,
    maxWidth,
    height: pickSized(source.height, DEFAULT_KEVIN_HUD.height, ...HUD_LIMITS.height),
    radius: pickNonNegative(source.radius, DEFAULT_KEVIN_HUD.radius, HUD_LIMITS.radius[1]),
    borderWidth: pickNonNegative(
      source.borderWidth,
      DEFAULT_KEVIN_HUD.borderWidth,
      HUD_LIMITS.borderWidth[1]
    ),
    borderColor: pickColor(source.borderColor, DEFAULT_KEVIN_HUD.borderColor),
    backgroundMode: pickEnum(source.backgroundMode, BACKGROUND_MODES, DEFAULT_KEVIN_HUD.backgroundMode),
    gradient,
    material: isMaterial(source.material) ? source.material : DEFAULT_KEVIN_HUD.material,
    backgroundColor: pickColor(source.backgroundColor, DEFAULT_KEVIN_HUD.backgroundColor),
    foregroundOpacity: pickNumber(
      foregroundOpacitySource(source),
      DEFAULT_KEVIN_HUD.foregroundOpacity,
      ...HUD_LIMITS.foregroundOpacity
    ),
    backgroundOpacity: pickNumber(
      source.backgroundOpacity,
      DEFAULT_KEVIN_HUD.backgroundOpacity,
      ...HUD_LIMITS.backgroundOpacity
    ),
    textColor,
    iconColor: source.iconColor === null
      ? null
      : isHexColor(source.iconColor) ? source.iconColor.trim() : DEFAULT_KEVIN_HUD.iconColor,
    textOffsetX: pickNumber(source.textOffsetX, DEFAULT_KEVIN_HUD.textOffsetX, ...HUD_LIMITS.textOffsetX),
    textOffsetY: pickNumber(source.textOffsetY, DEFAULT_KEVIN_HUD.textOffsetY, ...HUD_LIMITS.textOffsetY),
    iconOffsetX: pickNumber(source.iconOffsetX, DEFAULT_KEVIN_HUD.iconOffsetX, ...HUD_LIMITS.iconOffsetX),
    iconOffsetY: pickNumber(source.iconOffsetY, DEFAULT_KEVIN_HUD.iconOffsetY, ...HUD_LIMITS.iconOffsetY),
    fontScale: pickNumber(source.fontScale, DEFAULT_KEVIN_HUD.fontScale, ...HUD_LIMITS.fontScale),
    itemGap: pickNonNegative(source.itemGap, DEFAULT_KEVIN_HUD.itemGap, HUD_LIMITS.itemGap[1]),
    contentPadding: pickNonNegative(
      source.contentPadding,
      DEFAULT_KEVIN_HUD.contentPadding,
      HUD_LIMITS.contentPadding[1]
    ),
    itemStyle: { ...itemStyle },
    itemStyles,
    monitor: pickEnum(source.monitor, MONITORS, DEFAULT_KEVIN_HUD.monitor),
    autoWidth,
    restoreLauncher: pickBoolean(source.restoreLauncher, DEFAULT_KEVIN_HUD.restoreLauncher),
    hotkey: pickHotkey(source.hotkey),
    metrics
  }
}

/** Validate an already-normalized HUD config (the config store's write guard). */
export function isKevinHudConfig(value: unknown): value is KevinHudConfig {
  if (!isRecord(value)) return false
  const validNumber = (field: unknown, min: number, max: number): boolean =>
    typeof field === 'number' && Number.isFinite(field) && field >= min && field <= max
  const validSized = (field: unknown, min: number, max: number): boolean =>
    typeof field === 'number' && Number.isFinite(field) && field >= min && field <= max
  const completeItemStyle = (style: unknown): style is KevinHudItemStyle =>
    isPartialItemStyle(style) &&
    [...ITEM_STYLE_KEYS].every((key) =>
      Object.hasOwn(style as Record<string, unknown>, key)
    )
  const validItemStyles = isRecord(value.itemStyles) &&
    Object.entries(value.itemStyles).every(
      ([metric, style]) => isMetric(metric) && isItemStyleOverride(style)
    )
  return (
    typeof value.enabled === 'boolean' &&
    typeof value.alwaysVisible === 'boolean' &&
    typeof value.absorbLauncher === 'boolean' &&
    validNumber(value.displaySeconds, ...HUD_LIMITS.displaySeconds) &&
    validNumber(value.sampleSeconds, ...HUD_LIMITS.sampleSeconds) &&
    isEnum(value.direction, DIRECTIONS) &&
    validNumber(value.bounce, ...HUD_LIMITS.bounce) &&
    validNumber(value.ripple, ...HUD_LIMITS.ripple) &&
    isEnum(value.positionMode, POSITION_MODES) &&
    isEnum(value.anchor, ANCHORS) &&
    validNumber(value.x, ...HUD_LIMITS.x) &&
    validNumber(value.y, ...HUD_LIMITS.y) &&
    validSized(value.width, ...HUD_LIMITS.width) &&
    validSized(value.maxWidth, ...HUD_LIMITS.maxWidth) &&
    (value.maxWidth as number) >= (value.width as number) &&
    validSized(value.height, ...HUD_LIMITS.height) &&
    validNumber(value.radius, ...HUD_LIMITS.radius) &&
    validNumber(value.borderWidth, ...HUD_LIMITS.borderWidth) &&
    isHexColor(value.borderColor) &&
    isEnum(value.backgroundMode, BACKGROUND_MODES) &&
    isKevinHudGradient(value.gradient) &&
    isMaterial(value.material) &&
    isHexColor(value.backgroundColor) &&
    validNumber(value.foregroundOpacity, ...HUD_LIMITS.foregroundOpacity) &&
    validNumber(value.backgroundOpacity, ...HUD_LIMITS.backgroundOpacity) &&
    (value.textColor === 'auto' || isHexColor(value.textColor)) &&
    (value.iconColor === null || isHexColor(value.iconColor)) &&
    validNumber(value.textOffsetX, ...HUD_LIMITS.textOffsetX) &&
    validNumber(value.textOffsetY, ...HUD_LIMITS.textOffsetY) &&
    validNumber(value.iconOffsetX, ...HUD_LIMITS.iconOffsetX) &&
    validNumber(value.iconOffsetY, ...HUD_LIMITS.iconOffsetY) &&
    validNumber(value.fontScale, ...HUD_LIMITS.fontScale) &&
    validNumber(value.itemGap, ...HUD_LIMITS.itemGap) &&
    validNumber(value.contentPadding, ...HUD_LIMITS.contentPadding) &&
    completeItemStyle(value.itemStyle) &&
    validItemStyles &&
    isEnum(value.monitor, MONITORS) &&
    typeof value.autoWidth === 'boolean' &&
    typeof value.restoreLauncher === 'boolean' &&
    (value.hotkey === null || pickHotkey(value.hotkey) === value.hotkey) &&
    Array.isArray(value.metrics) &&
    value.metrics.every(isMetric) &&
    new Set(value.metrics).size === value.metrics.length
  )
}
