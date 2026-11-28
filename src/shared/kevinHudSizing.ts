import {
  DEFAULT_KEVIN_HUD,
  DEFAULT_KEVIN_HUD_ITEM_STYLE,
  KEVIN_HUD_ITEM_STYLE_LIMITS,
  KEVIN_HUD_LEGACY_AUTO_MAX_WIDTH,
  KEVIN_HUD_LIMITS,
  usesKevinHudMemoryReadout,
  type KevinHudConfig,
  type KevinHudItemAlign,
  type KevinHudItemStyle,
  type KevinHudItemStyles,
  type KevinHudMetric
} from './kevinHud'
import {
  KEVIN_HUD_DURATION_TEXT_CANDIDATES,
  KEVIN_HUD_DURATION_WIDEST_TEXT,
  KEVIN_HUD_RATE_TEXT_CANDIDATES,
  KEVIN_HUD_RATE_WIDEST_TEXT
} from './kevinHudMetricText'

export {
  usesKevinHudMemoryReadout,
  type KevinHudItemAlign,
  type KevinHudItemDescription,
  type KevinHudItemOrientation,
  type KevinHudItemStyle
} from './kevinHud'

/**
 * Shared sizing contract for KEVIN HUD items.
 *
 * The HUD is still allowed to grow horizontally, but only inside explicit
 * positive bounds. `width` keeps its historical meaning:
 *
 * - fixed mode (`autoWidth: false`): the manual width, i.e. min === max;
 * - grow mode (`autoWidth: true`): the minimum width;
 * - `maxWidth` is the optional upper bound for grow mode.
 *
 * A missing `maxWidth` must not break an old saved HUD. Fixed widths therefore
 * resolve to min === max === width, and legacy grow mode keeps its broad upper
 * bound. A missing `autoWidth` is treated as fixed mode for the same reason.
 *
 * All widths returned here are finite DIPs. Duration, network and other metric
 * slots reserve the widest of every candidate emitted by the formatter. A value
 * that is still longer is never ellipsized or wrapped: its cell grows by natural
 * content width and the one-row bank switches to its internal scroll, so
 * changing a sample can never clip a value.
 */

/**
 * Sizing consumes the persisted shape rather than redeclaring it. Keeping the
 * fields tied to `KevinHudConfig` means a future saved field cannot silently
 * use a different range in the native sizing helpers and in the renderer.
 *
 * Everything stays optional so pre-HUD saved configs and partial renderer
 * drafts remain valid; missing fields fall back to `DEFAULT_KEVIN_HUD`.
 * `verticalPadding` is a legacy/manual override accepted by the resolver. It is
 * not persisted by `KevinHudConfig`, where `contentPadding` keeps its compact
 * one-value contract.
 */
type KevinHudSizingField =
  | 'width'
  | 'height'
  | 'autoWidth'
  | 'maxWidth'
  | 'fontScale'
  | 'borderWidth'
  | 'itemGap'
  | 'contentPadding'

export type KevinHudSizingConfig =
  Partial<Pick<KevinHudConfig, KevinHudSizingField>> & {
    /** Read-only selections from renderer drafts and native callers are fine. */
    metrics?: readonly KevinHudMetric[]
    itemStyle?: Partial<KevinHudItemStyle> | null
    itemStyles?: KevinHudItemStyles | null
    verticalPadding?: number | null
  }

export interface KevinHudWidthBounds {
  minWidth: number
  maxWidth: number
  auto: boolean
}

export interface KevinHudContentPadding {
  horizontal: number
  vertical: number
}

export interface KevinHudMetricTemplate {
  /** Compact English description shown beside a value. */
  label: string
  /** Conservative single form; candidate measurement also includes it. */
  template: string
}

export interface KevinHudItemGeometry {
  /** Actual app name, used only by the appName identity item. */
  appName?: string | null
  /** Optional override; otherwise derived from the configured height. */
  iconSize?: number
  fontScale?: number
}

export const KEVIN_HUD_DEFAULT_WIDTH = DEFAULT_KEVIN_HUD.width
export const KEVIN_HUD_DEFAULT_HEIGHT = DEFAULT_KEVIN_HUD.height
export const KEVIN_HUD_DEFAULT_MAX_WIDTH = DEFAULT_KEVIN_HUD.maxWidth
export const KEVIN_HUD_MIN_ALLOWED_WIDTH = KEVIN_HUD_LIMITS.width[0]
export const KEVIN_HUD_MAX_ALLOWED_WIDTH = KEVIN_HUD_LIMITS.width[1]
export const KEVIN_HUD_MIN_ALLOWED_HEIGHT = KEVIN_HUD_LIMITS.height[0]
export const KEVIN_HUD_MAX_ALLOWED_HEIGHT = KEVIN_HUD_LIMITS.height[1]

/** Wide, quiet margin of the reference 448 x 48 capsule. */
export const KEVIN_HUD_DEFAULT_CONTENT_PADDING = DEFAULT_KEVIN_HUD.contentPadding
export const KEVIN_HUD_DEFAULT_VERTICAL_PADDING = 4
export const KEVIN_HUD_MAX_CONTENT_PADDING = KEVIN_HUD_LIMITS.contentPadding[1]
export const KEVIN_HUD_DEFAULT_ITEM_GAP = DEFAULT_KEVIN_HUD.itemGap
export const KEVIN_HUD_MAX_ITEM_GAP = KEVIN_HUD_LIMITS.itemGap[1]
export const KEVIN_HUD_CELL_INLINE_PADDING = 4
export const KEVIN_HUD_MIN_ITEM_WIDTH = 24
export const KEVIN_HUD_MAX_ITEM_WIDTH = 4096
/**
 * The launch announcement's fixed trailing status copy, its CSS size/tracking
 * and the gap between the title block and that copy. The renderer draws the
 * same token; sharing them keeps an auto-width announcement from squeezing the
 * right side while still allowing a narrow host to ellipsize the app name.
 */
export const KEVIN_HUD_ANNOUNCE_STATUS_TEXT = '启动中'
export const KEVIN_HUD_ANNOUNCE_STATUS_SIZE = 11.5
export const KEVIN_HUD_ANNOUNCE_STATUS_TRACKING = 0.08
export const KEVIN_HUD_ANNOUNCE_STATUS_GAP = 10
/**
 * Stable reserve for the dedicated memory capsule. It fits the widest normal
 * used/total/percentage triple plus the 16-DIP chip glyph and lime arc; a
 * narrower host scrolls rather than clipping this documented form. The shared
 * item measurement reserves this floor even when the per-item `minWidth` is
 * still 0.
 */
export const KEVIN_HUD_MEMORY_READOUT_MIN_WIDTH = 300

/**
 * Fixed optical reference of the dedicated memory readout, measured on the
 * default 448 x 48 capsule. The app-wide item `valueSize` / `descriptionSize`
 * and the existing `fontScale` scale these values; the settled plate height is
 * only an output of the measurement and must never feed back into the type.
 * The disc, ring and reference insets stay at their 48-DIP geometry.
 */
export const KEVIN_HUD_MEMORY_REFERENCE = Object.freeze({
  height: 48,
  usedSize: 20.8,
  totalSize: 11.2,
  percentSize: 17.6,
  percentSignSize: 10.4,
  badgeSize: 36.8,
  ringSize: 3.6,
  descriptionTextSize: 11.2,
  descriptionIconSize: 16.8,
  descriptionSize: 8.5,
  valueSize: 14
})

/**
 * The reference item uses a leading icon descriptor and a right-aligned
 * 14-DIP value. Per-metric overrides are limited to the gap, minimum width,
 * the two alignments and the two colours. The merged app identity keeps the
 * app-wide type/layout but pins its descriptor to the real icon. The config
 * module owns the one canonical default so the saved contract, settings UI and
 * renderer cannot drift.
 */
export const KEVIN_HUD_ITEM_DEFAULT: Readonly<KevinHudItemStyle> = Object.freeze({
  ...DEFAULT_KEVIN_HUD_ITEM_STYLE
})

/**
 * Bounds for the merged app identity's actual title. The title is a real value,
 * so a long name may scroll inside its own cell; the slot itself stays bounded
 * so one pathological name cannot push the whole HUD to its maximum width.
 */
export const KEVIN_HUD_APP_NAME_MIN_WIDTH = 54
export const KEVIN_HUD_APP_NAME_MAX_WIDTH = 360

/**
 * Dedicated launch-announcement geometry: triangle, round icon, app name and
 * the trailing "启动中" copy. These values are deliberately independent from
 * `KevinHudItemStyle` so a monitoring typography preference cannot distort the
 * announcement's separate layout or cadence.
 */
export const KEVIN_HUD_ANNOUNCE_ICON_SIZE = 22
export const KEVIN_HUD_ANNOUNCE_LAUNCH_MARK_WIDTH = 7
export const KEVIN_HUD_ANNOUNCE_LAUNCH_MARK_GAP = 7
export const KEVIN_HUD_ANNOUNCE_TITLE_GAP = 6
export const KEVIN_HUD_ANNOUNCE_TITLE_SIZE = 12.5

/**
 * Reserved display metadata and templates.
 *
 * `FPS` is capped by the sampler at 10,000 and rendered with at most one
 * decimal. Durations use the bounded formatter in `kevinHudMetricText` (six
 * hour digits, then a compact day/scientific fallback). Percentages are 0..100.
 * Network rates use the same formatter's one-decimal unit branches and a
 * bounded scientific GB/s fallback. `appName` is the merged icon/name identity;
 * its actual title is estimated separately from this fixed template map.
 *
 * `template` is the single conservative fallback; the authoritative sizing
 * input is `getKevinHudValueTextCandidates(metric)`, whose every member is
 * measured. That list includes this template, so a future formatter branch
 * cannot be narrower than its reserved slot without a sizing regression.
 */
export const KEVIN_HUD_METRIC_TEMPLATES: Record<KevinHudMetric, KevinHudMetricTemplate> = {
  appName: { label: '', template: 'KEVIN' },
  sessionTime: { label: 'SESSION', template: KEVIN_HUD_DURATION_WIDEST_TEXT },
  totalTime: { label: 'TOTAL', template: KEVIN_HUD_DURATION_WIDEST_TEXT },
  fps: { label: 'FPS', template: '10000.0' },
  gpu: { label: 'GPU', template: '100%' },
  cpu: { label: 'CPU', template: '100%' },
  memory: { label: 'MEM', template: '100%' },
  download: { label: 'DOWN', template: KEVIN_HUD_RATE_WIDEST_TEXT },
  upload: { label: 'UP', template: KEVIN_HUD_RATE_WIDEST_TEXT },
  clock: { label: 'CLOCK', template: '00:00' }
}

type KevinHudValueMetric = Exclude<KevinHudMetric, 'appName'>

/**
 * All fixed-slot display forms for a metric, including the conservative
 * template. Duration/network lists come from the formatter module, which owns
 * the exact rounding carries and extreme finite fallbacks.
 *
 * The renderer can measure these with the real selected font (canvas measure)
 * after fonts settle and reserve the widest result. The deterministic DIP
 * estimate below already measures every entry, so these candidates are never
 * silently clipped by the shared layout.
 */
function valueTextCandidates(
  metric: KevinHudValueMetric,
  candidates: readonly string[] = []
): readonly string[] {
  return Object.freeze([
    ...new Set([...candidates, KEVIN_HUD_METRIC_TEMPLATES[metric].template])
  ])
}

const KEVIN_HUD_VALUE_TEXT_CANDIDATES: Readonly<
  Record<KevinHudValueMetric, readonly string[]>
> = Object.freeze({
  sessionTime: valueTextCandidates('sessionTime', KEVIN_HUD_DURATION_TEXT_CANDIDATES),
  totalTime: valueTextCandidates('totalTime', KEVIN_HUD_DURATION_TEXT_CANDIDATES),
  fps: valueTextCandidates('fps'),
  gpu: valueTextCandidates('gpu'),
  cpu: valueTextCandidates('cpu'),
  memory: valueTextCandidates('memory'),
  download: valueTextCandidates('download', KEVIN_HUD_RATE_TEXT_CANDIDATES),
  upload: valueTextCandidates('upload', KEVIN_HUD_RATE_TEXT_CANDIDATES),
  clock: valueTextCandidates('clock')
})

const NO_VALUE_TEXT_CANDIDATES: readonly string[] = Object.freeze([])

/**
 * Fixed-slot texts to measure with the real font. The merged app identity has
 * a dynamic actual name rather than a bounded fixed-slot value, so it
 * deliberately returns an empty list and is measured from `geometry.appName`.
 */
export function getKevinHudValueTextCandidates(metric: KevinHudMetric): readonly string[] {
  if (metric === 'appName') return NO_VALUE_TEXT_CANDIDATES
  return KEVIN_HUD_VALUE_TEXT_CANDIDATES[metric] ?? NO_VALUE_TEXT_CANDIDATES
}

const ASCII_NARROW = /[ijlI.,:;'!|]/
const ASCII_WIDE = /[MW@#%&]/
const WIDE_CHARACTER =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const finitePositive = (value: unknown): value is number => finite(value) && value > 0

const ITEM_ALIGNS = ['left', 'center', 'right'] as const

const isItemAlign = (value: unknown): value is KevinHudItemAlign =>
  typeof value === 'string' && (ITEM_ALIGNS as readonly string[]).includes(value)

const pickNumber = (
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number => (finite(value) ? clamp(value, min, max) : fallback)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function resolveKevinHudWidthBounds(
  config: KevinHudSizingConfig | null | undefined
): KevinHudWidthBounds {
  const width = Math.round(
    pickNumber(
      config?.width,
      KEVIN_HUD_DEFAULT_WIDTH,
      KEVIN_HUD_MIN_ALLOWED_WIDTH,
      KEVIN_HUD_MAX_ALLOWED_WIDTH
    )
  )
  const explicitMax = finitePositive(config?.maxWidth)
    ? Math.round(
        clamp(
          config.maxWidth,
          KEVIN_HUD_MIN_ALLOWED_WIDTH,
          KEVIN_HUD_MAX_ALLOWED_WIDTH
        )
      )
    : null
  if (config?.autoWidth !== true) {
    // A legacy fixed HUD with no maxWidth saves only its manual width, so
    // min === max. An explicit newer max is a non-binding cap above that width
    // and must never shrink the user's fixed width.
    return {
      minWidth: width,
      maxWidth: Math.max(width, explicitMax ?? width),
      auto: false
    }
  }

  // A raw `autoWidth: true` with no explicit cap is the historical grow mode;
  // the normalized new default is fixed, so this fallback only applies to a
  // caller that deliberately kept growing and omitted the cap.
  const maximum = explicitMax ?? KEVIN_HUD_LEGACY_AUTO_MAX_WIDTH
  return {
    minWidth: width,
    // A manually stored minimum must win over an accidentally smaller max:
    // min/max stay positive and ordered rather than producing an invalid CSS
    // clamp or a zero-width slot.
    maxWidth: Math.max(width, maximum),
    auto: true
  }
}

export function resolveKevinHudHeightLowerBound(
  config: KevinHudSizingConfig | null | undefined
): number {
  return Math.round(
    pickNumber(
      config?.height,
      KEVIN_HUD_DEFAULT_HEIGHT,
      KEVIN_HUD_MIN_ALLOWED_HEIGHT,
      KEVIN_HUD_MAX_ALLOWED_HEIGHT
    )
  )
}

export function resolveKevinHudItemGap(
  config: KevinHudSizingConfig | null | undefined
): number {
  return Math.round(
    pickNumber(
      config?.itemGap,
      KEVIN_HUD_DEFAULT_ITEM_GAP,
      KEVIN_HUD_LIMITS.itemGap[0],
      KEVIN_HUD_MAX_ITEM_GAP
    )
  )
}

/**
 * Resolve content padding.
 *
 * `contentPadding` widens the capsule and supplies a small vertical share that
 * keeps the reference's large type at its intended optical size. A caller that
 * needs more room can supply the optional `verticalPadding`, which is honored
 * in full.
 *
 * The user's configured height is only a lower bound and deliberately does not
 * participate here. A short saved height must never squeeze padding; the
 * natural height is raised by `measureKevinHudMinContentHeight` instead.
 */
export function resolveKevinHudContentPadding(
  config: KevinHudSizingConfig | null | undefined
): KevinHudContentPadding {
  const horizontal = Math.round(
    pickNumber(
      config?.contentPadding,
      KEVIN_HUD_DEFAULT_CONTENT_PADDING,
      KEVIN_HUD_LIMITS.contentPadding[0],
      KEVIN_HUD_MAX_CONTENT_PADDING
    )
  )
  const vertical = Math.round(
    pickNumber(
      config?.verticalPadding,
      finite(config?.contentPadding)
        ? Math.min(horizontal, KEVIN_HUD_DEFAULT_VERTICAL_PADDING)
        : KEVIN_HUD_DEFAULT_VERTICAL_PADDING,
      KEVIN_HUD_LIMITS.contentPadding[0],
      KEVIN_HUD_MAX_CONTENT_PADDING
    )
  )
  return { horizontal, vertical }
}

export function resolveKevinHudFontScale(
  config: KevinHudSizingConfig | null | undefined
): number {
  return pickNumber(
    config?.fontScale,
    DEFAULT_KEVIN_HUD.fontScale,
    KEVIN_HUD_LIMITS.fontScale[0],
    KEVIN_HUD_LIMITS.fontScale[1]
  )
}

export interface KevinHudMemoryReadoutTypeSizing {
  /** Multiplier applied to every numeric amount in the readout. */
  valueScale: number
  /** Multiplier applied to the descriptor text and the two glyph marks. */
  descriptionScale: number
  usedSize: number
  totalSize: number
  percentSize: number
  percentSignSize: number
  descriptionTextSize: number
  descriptionIconSize: number
}

/**
 * Resolve the dedicated readout's type from the fixed 448 x 48 reference.
 *
 * `valueSize` and `descriptionSize` are independent app-wide settings, so the
 * three amounts and the descriptor/glyphs scale separately. The renderer maps
 * the two scale multipliers into CSS variables; the text sizes here let the
 * shared height measurement reserve the same optical size without using the
 * already-raised plate height as an input.
 */
export function resolveKevinHudMemoryReadoutTypeSizing(
  itemStyle:
    | Pick<KevinHudItemStyle, 'valueSize' | 'descriptionSize'>
    | null
    | undefined,
  fontScale = 1
): KevinHudMemoryReadoutTypeSizing {
  const valueSize = finitePositive(itemStyle?.valueSize)
    ? itemStyle.valueSize
    : KEVIN_HUD_MEMORY_REFERENCE.valueSize
  const descriptionSize = finitePositive(itemStyle?.descriptionSize)
    ? itemStyle.descriptionSize
    : KEVIN_HUD_MEMORY_REFERENCE.descriptionSize
  const textScale = finitePositive(fontScale) ? fontScale : 1
  const valueScale = valueSize / KEVIN_HUD_MEMORY_REFERENCE.valueSize
  const descriptionScale =
    descriptionSize / KEVIN_HUD_MEMORY_REFERENCE.descriptionSize
  return {
    valueScale,
    descriptionScale,
    usedSize:
      KEVIN_HUD_MEMORY_REFERENCE.usedSize * valueScale * textScale,
    totalSize:
      KEVIN_HUD_MEMORY_REFERENCE.totalSize * valueScale * textScale,
    percentSize:
      KEVIN_HUD_MEMORY_REFERENCE.percentSize * valueScale * textScale,
    percentSignSize:
      KEVIN_HUD_MEMORY_REFERENCE.percentSignSize * valueScale * textScale,
    descriptionTextSize:
      KEVIN_HUD_MEMORY_REFERENCE.descriptionTextSize *
      descriptionScale *
      textScale,
    // The two marks are optical glyphs, not text: they follow the descriptor
    // size alone so fontScale cannot make them outgrow their disc.
    descriptionIconSize:
      KEVIN_HUD_MEMORY_REFERENCE.descriptionIconSize * descriptionScale
  }
}

const HEX_COLOR = /^#[\da-f]{6}$/i

const itemColor = (
  value: unknown,
  fallback: string | null
): string | null => {
  if (value === null) return null
  return typeof value === 'string' && HEX_COLOR.test(value.trim())
    ? value.trim()
    : fallback
}

function normalizeItemStyle(
  value: unknown,
  fallback: Readonly<KevinHudItemStyle>
): KevinHudItemStyle {
  if (!isRecord(value)) return { ...fallback }
  return {
    orientation:
      value.orientation === 'vertical' || value.orientation === 'horizontal'
        ? value.orientation
        : fallback.orientation,
    description:
      value.description === 'icon' || value.description === 'text'
        ? value.description
        : fallback.description,
    gap: Math.round(
      pickNumber(
        value.gap,
        fallback.gap,
        KEVIN_HUD_ITEM_STYLE_LIMITS.gap[0],
        KEVIN_HUD_ITEM_STYLE_LIMITS.gap[1]
      )
    ),
    minWidth: pickNumber(
      value.minWidth,
      fallback.minWidth,
      KEVIN_HUD_ITEM_STYLE_LIMITS.minWidth[0],
      KEVIN_HUD_ITEM_STYLE_LIMITS.minWidth[1]
    ),
    descriptionAlign: isItemAlign(value.descriptionAlign)
      ? value.descriptionAlign
      : fallback.descriptionAlign,
    valueAlign: isItemAlign(value.valueAlign)
      ? value.valueAlign
      : fallback.valueAlign,
    descriptionSize: pickNumber(
      value.descriptionSize,
      fallback.descriptionSize,
      KEVIN_HUD_ITEM_STYLE_LIMITS.descriptionSize[0],
      KEVIN_HUD_ITEM_STYLE_LIMITS.descriptionSize[1]
    ),
    valueSize: pickNumber(
      value.valueSize,
      fallback.valueSize,
      KEVIN_HUD_ITEM_STYLE_LIMITS.valueSize[0],
      KEVIN_HUD_ITEM_STYLE_LIMITS.valueSize[1]
    ),
    descriptionBold:
      typeof value.descriptionBold === 'boolean'
        ? value.descriptionBold
        : fallback.descriptionBold,
    valueBold:
      typeof value.valueBold === 'boolean' ? value.valueBold : fallback.valueBold,
    descriptionColor: itemColor(value.descriptionColor, fallback.descriptionColor),
    valueColor: itemColor(value.valueColor, fallback.valueColor)
  }
}

/**
 * Apply the only legal per-metric patch: gap, minimum width, the two
 * alignments and the two colours. Historical beta overrides may still contain
 * layout/type/weight fields in memory; they are ignored so every item keeps the
 * app-wide orientation, size and weight. The merged `appName` form additionally
 * pins its descriptor to the real app icon in `getKevinHudItemStyle`.
 */
function applyItemStyleOverride(
  base: KevinHudItemStyle,
  value: unknown
): KevinHudItemStyle {
  if (!isRecord(value)) return { ...base }
  return {
    ...base,
    gap: Math.round(
      pickNumber(
        value.gap,
        base.gap,
        KEVIN_HUD_ITEM_STYLE_LIMITS.gap[0],
        KEVIN_HUD_ITEM_STYLE_LIMITS.gap[1]
      )
    ),
    minWidth: pickNumber(
      value.minWidth,
      base.minWidth,
      KEVIN_HUD_ITEM_STYLE_LIMITS.minWidth[0],
      KEVIN_HUD_ITEM_STYLE_LIMITS.minWidth[1]
    ),
    descriptionAlign: isItemAlign(value.descriptionAlign)
      ? value.descriptionAlign
      : base.descriptionAlign,
    valueAlign: isItemAlign(value.valueAlign)
      ? value.valueAlign
      : base.valueAlign,
    // An explicit per-item `null` is a reset to the readable reference colour;
    // it does not re-inherit an app-wide custom colour. Omitting the field
    // (undefined) keeps that app-wide colour.
    descriptionColor: Object.hasOwn(value, 'descriptionColor')
      ? itemColor(value.descriptionColor, base.descriptionColor)
      : base.descriptionColor,
    valueColor: Object.hasOwn(value, 'valueColor')
      ? itemColor(value.valueColor, base.valueColor)
      : base.valueColor
  }
}

/**
 * Resolve the item style for one metric.
 *
 * Precedence is per-metric gap/minimum-width/alignment/colour override >
 * general `itemStyle` > reference default. The merged `appName` identity
 * follows the app-wide orientation, type size and weight (and its own legal
 * overrides), but its descriptor form is always `icon`: the renderer draws the
 * real application icon, with the existing fallback when the app has no
 * artwork.
 */
export function getKevinHudItemStyle(
  config: KevinHudSizingConfig | null | undefined,
  metric: KevinHudMetric
): KevinHudItemStyle {
  const base = normalizeItemStyle(config?.itemStyle, KEVIN_HUD_ITEM_DEFAULT)
  const perMetric = isRecord(config?.itemStyles)
    ? config.itemStyles[metric]
    : undefined
  const style = applyItemStyleOverride(base, perMetric)
  return metric === 'appName' ? { ...style, description: 'icon' } : style
}

const characterWidth = (character: string, size: number): number => {
  if (character === ' ') return size * 0.31
  if (WIDE_CHARACTER.test(character)) return size
  if (ASCII_NARROW.test(character)) return size * 0.32
  if (ASCII_WIDE.test(character)) return size * 0.82
  return size * 0.62
}

/**
 * Stable, font-independent DIP estimate for arbitrary text at a nominal size.
 *
 * This is intentionally only a reserve estimate; the renderer measures the
 * exported candidate texts with the actual selected font after it settles. The
 * per-character caps keep one pathological saved label from producing an
 * unbounded slot.
 */
export function measureKevinHudTextWidth(text: string, size: number): number {
  if (typeof text !== 'string' || !finitePositive(size)) return 0
  let width = 0
  let count = 0
  for (const character of text) {
    if (++count > 512) break
    width += characterWidth(character, size)
  }
  return width
}

/**
 * Reserve for the announcement's fixed trailing status copy. It follows the
 * same font scale as the title so a 1.25x HUD keeps the status fully visible.
 */
export function measureKevinHudAnnounceStatusWidth(
  config: KevinHudSizingConfig | null | undefined,
  text: string = KEVIN_HUD_ANNOUNCE_STATUS_TEXT
): number {
  const copy = typeof text === 'string' && text.trim()
    ? text.trim()
    : KEVIN_HUD_ANNOUNCE_STATUS_TEXT
  const size = KEVIN_HUD_ANNOUNCE_STATUS_SIZE * resolveKevinHudFontScale(config)
  const measured = measureKevinHudTextWidth(copy, size)
  // The rendered status adds 0.08em tracking between characters and a small
  // glyph-metric guard, matching the description reserve convention.
  return Math.ceil(
    measured + copy.length * size * KEVIN_HUD_ANNOUNCE_STATUS_TRACKING + 2
  )
}

/**
 * Measure the announcement's independent triangle + round icon + actual name +
 * trailing status row. This deliberately uses its own launch geometry instead
 * of `KevinHudItemStyle`, so monitoring font sizes, weights, orientation and
 * per-metric overrides cannot distort the launch layout.
 */
export function measureKevinHudAnnouncementWidth(
  config: KevinHudSizingConfig | null | undefined,
  appName: string | null | undefined,
  statusText: string = KEVIN_HUD_ANNOUNCE_STATUS_TEXT
): number {
  const safe = config ?? {}
  const scale = resolveKevinHudFontScale(safe)
  const name = typeof appName === 'string' && appName.trim()
    ? appName.trim()
    : KEVIN_HUD_METRIC_TEMPLATES.appName.template
  const titleWidth = Math.ceil(
    clamp(
      measureKevinHudTextWidth(name, KEVIN_HUD_ANNOUNCE_TITLE_SIZE * scale) + 10,
      KEVIN_HUD_APP_NAME_MIN_WIDTH,
      KEVIN_HUD_APP_NAME_MAX_WIDTH
    )
  )
  const launchWidth =
    KEVIN_HUD_ANNOUNCE_LAUNCH_MARK_WIDTH +
    KEVIN_HUD_ANNOUNCE_LAUNCH_MARK_GAP +
    KEVIN_HUD_ANNOUNCE_ICON_SIZE +
    KEVIN_HUD_ANNOUNCE_TITLE_GAP
  const statusWidth = measureKevinHudAnnounceStatusWidth(safe, statusText)
  const padding = resolveKevinHudContentPadding(safe)
  const border = pickNumber(
    safe.borderWidth,
    DEFAULT_KEVIN_HUD.borderWidth,
    KEVIN_HUD_LIMITS.borderWidth[0],
    KEVIN_HUD_LIMITS.borderWidth[1]
  )
  return Math.ceil(
    launchWidth +
      titleWidth +
      KEVIN_HUD_ANNOUNCE_STATUS_GAP +
      statusWidth +
      padding.horizontal * 2 +
      border * 2
  )
}

export function resolveKevinHudIconSize(
  config: KevinHudSizingConfig | null | undefined
): number {
  const height = resolveKevinHudHeightLowerBound(config)
  return height < 36 ? 18 : 22
}

/**
 * Stable value reserve for one metric. The returned width is exactly the slot
 * kept by the renderer's value. The description and item gap are added by
 * `measureKevinHudItemWidth`.
 *
 * Every bounded candidate emitted for the metric is measured and the widest
 * result is reserved. The list includes the conservative template, so duration
 * rounding carries (`1024.0 MB/s`) and finite scientific fallbacks are covered
 * even when their glyph count differs from the old single template. The merged
 * `appName` value is the stable actual app title; a long title stays bounded
 * and scrolls inside its own cell rather than being clipped.
 */
export function measureKevinHudValueWidth(
  config: KevinHudSizingConfig | null | undefined,
  metric: KevinHudMetric,
  geometry: KevinHudItemGeometry = {}
): number {
  const style = getKevinHudItemStyle(config, metric)
  const scale = finitePositive(geometry.fontScale)
    ? geometry.fontScale
    : resolveKevinHudFontScale(config)
  const size = style.valueSize * scale
  if (metric === 'appName') {
    const name = typeof geometry.appName === 'string' && geometry.appName.trim()
      ? geometry.appName.trim()
      : KEVIN_HUD_METRIC_TEMPLATES.appName.template
    const measured = measureKevinHudTextWidth(name, size)
    return Math.ceil(
      clamp(measured + 10, KEVIN_HUD_APP_NAME_MIN_WIDTH, KEVIN_HUD_APP_NAME_MAX_WIDTH)
    )
  }
  const widest = getKevinHudValueTextCandidates(metric).reduce(
    (width, text) => Math.max(width, measureKevinHudTextWidth(text, size)),
    0
  )
  // The 2-DIP guard keeps nominal font-metric variation, including bold tabular
  // digits, out of layout changes. The renderer validates the exported
  // candidates with the real font and reserves the measured maximum.
  return Math.max(12, Math.ceil(widest + 2))
}

/**
 * The monitored app identity reuses the icon-description slot. Its rendered
 * size follows the unified descriptor size exactly like the other icon
 * descriptors, so the shared reserve must use the same value.
 */
const monitoredItemIconSize = (style: KevinHudItemStyle): number =>
  Math.max(12, Math.ceil(style.descriptionSize * 1.35))

function measureDescriptionWidth(
  metric: KevinHudMetric,
  style: KevinHudItemStyle,
  fontScale: number
): number {
  const scale = finitePositive(fontScale) ? fontScale : 1
  if (style.description === 'icon') {
    // The renderer draws the glyph from the unscaled descriptor size; using the
    // larger of one and the global text scale keeps the slot safe at 0.8x.
    return Math.max(
      12,
      Math.ceil(style.descriptionSize * Math.max(1, scale) * 1.35)
    )
  }
  const label = KEVIN_HUD_METRIC_TEMPLATES[metric]?.label ?? ''
  if (!label) return 0
  const size = style.descriptionSize * scale
  // The rendered eyebrow adds 0.11em tracking between upper-case letters.
  return Math.ceil(measureKevinHudTextWidth(label, size) + label.length * size * 0.11 + 2)
}

/** The dedicated instrument only exists for the single-metric memory profile. */
const isKevinHudMemoryOnly = (
  config: KevinHudSizingConfig
): boolean =>
  config.metrics?.length === 1 && config.metrics[0] === 'memory'

/**
 * Finite slot width for one item.
 *
 * The merged `appName` item is measured like a regular value: the leading real
 * app icon plus the configured inner gap plus the stable actual title (or its
 * calm fallback). A vertical item stacks those two, so its width is their
 * maximum and the configured gap is counted in height instead. Other metrics
 * use their bounded description/value templates.
 *
 * `minWidth` is a lower bound for the measured slot, never a cap on the
 * content: a slot is at least `max(minWidth, content geometry)`. The memory
 * profile alone keeps the dedicated instrument's documented 300 DIP reserve,
 * but only while its resolved style still uses the reference alignment. Any
 * customized alignment hands memory to the ordinary measured item layout.
 */
export function measureKevinHudItemWidth(
  config: KevinHudSizingConfig | null | undefined,
  metric: KevinHudMetric,
  geometry: KevinHudItemGeometry = {}
): number {
  const safe = config ?? {}
  const fontScale = finitePositive(geometry.fontScale)
    ? geometry.fontScale
    : resolveKevinHudFontScale(safe)
  const style = getKevinHudItemStyle(safe, metric)
  const valueWidth = measureKevinHudValueWidth(safe, metric, {
    ...geometry,
    fontScale
  })
  const descriptionWidth = metric === 'appName'
    ? Math.max(
        12,
        finitePositive(geometry.iconSize)
          ? Math.ceil(geometry.iconSize)
          : monitoredItemIconSize(style)
      )
    : measureDescriptionWidth(metric, style, fontScale)
  const content =
    style.orientation === 'vertical'
      ? Math.max(descriptionWidth, valueWidth)
      : descriptionWidth + style.gap + valueWidth
  const dedicatedMemory =
    metric === 'memory' &&
    isKevinHudMemoryOnly(safe) &&
    usesKevinHudMemoryReadout(style)
  const floor = Math.max(
    style.minWidth,
    dedicatedMemory ? KEVIN_HUD_MEMORY_READOUT_MIN_WIDTH : 0
  )
  return Math.ceil(
    clamp(
      Math.max(content + KEVIN_HUD_CELL_INLINE_PADDING * 2, floor),
      KEVIN_HUD_MIN_ITEM_WIDTH,
      KEVIN_HUD_MAX_ITEM_WIDTH
    )
  )
}

/**
 * Minimum settled height for the configured metrics.
 *
 * The user's height is a lower bound: the function never returns less than the
 * saved height. A taller value appears when the item typography (including a
 * vertical descriptor/value pair), the full resolved vertical padding and the
 * border genuinely need more room. Padding is therefore never reduced to fit a
 * short saved height. Everything is capped to the shared 240-DIP maximum so
 * malformed styles cannot create an unbounded plate; the maximum legal type,
 * padding and border combination still fits below that cap.
 *
 * The dedicated memory readout is a composition with its own fixed 448 x 48
 * reference type. Its branch below measures that type directly; the plate
 * height it returns is never read back into the font sizes. Other metrics,
 * and memory shown as one cell in a multi-item row, keep the generic contract.
 */
export function measureKevinHudMinContentHeight(
  config: KevinHudSizingConfig | null | undefined
): number {
  const safe = config ?? {}
  const requested = resolveKevinHudHeightLowerBound(safe)
  const padding = resolveKevinHudContentPadding(safe)
  const border = pickNumber(
    safe.borderWidth,
    DEFAULT_KEVIN_HUD.borderWidth,
    KEVIN_HUD_LIMITS.borderWidth[0],
    KEVIN_HUD_LIMITS.borderWidth[1]
  )
  const fontScale = resolveKevinHudFontScale(safe)
  let needed = requested

  for (const metric of safe.metrics ?? []) {
    const style = getKevinHudItemStyle(safe, metric)
    if (metric === 'appName') {
      // The merged identity's leading real app icon is part of the measured
      // content. Horizontally it shares the line with the title; vertically it
      // adds its own line plus the configured inner gap.
      const iconLine = monitoredItemIconSize(style)
      const valueLine = style.valueSize * fontScale * 1.22
      const content = style.orientation === 'vertical'
        ? valueLine + style.gap + iconLine
        : Math.max(valueLine, iconLine)
      needed = Math.max(
        needed,
        Math.ceil(content + padding.vertical * 2 + border * 2)
      )
      continue
    }
    if (
      metric === 'memory' &&
      isKevinHudMemoryOnly(safe) &&
      usesKevinHudMemoryReadout(style)
    ) {
      const type = resolveKevinHudMemoryReadoutTypeSizing(style, fontScale)
      const valueLine = Math.max(type.usedSize, type.percentSize) * 1.22
      const descriptionLine =
        style.description === 'icon'
          ? Math.max(12, type.descriptionIconSize)
          : type.descriptionTextSize * 1.22
      const content =
        style.orientation === 'vertical'
          ? valueLine + style.gap + descriptionLine
          : Math.max(valueLine, descriptionLine)
      // The memory-only content owner removes the generic content padding, so
      // only the plate border remains outside the readout.
      needed = Math.max(
        needed,
        Math.ceil(
          Math.max(KEVIN_HUD_MEMORY_REFERENCE.badgeSize, content) + border * 2
        )
      )
      continue
    }
    const valueLine = style.valueSize * fontScale * 1.22
    const descriptionLine =
      style.description === 'icon'
        ? Math.max(
          12,
          style.descriptionSize * Math.max(1, fontScale) * 1.35
        )
        : style.descriptionSize * fontScale * 1.22
    const content =
      style.orientation === 'vertical'
        ? valueLine + style.gap + descriptionLine
        : Math.max(valueLine, descriptionLine)
    needed = Math.max(
      needed,
      Math.ceil(content + padding.vertical * 2 + border * 2)
    )
  }

  return Math.round(
    clamp(
      needed,
      KEVIN_HUD_MIN_ALLOWED_HEIGHT,
      KEVIN_HUD_MAX_ALLOWED_HEIGHT
    )
  )
}

/**
 * Stable signature for layout-affecting optional fields. The renderer uses it
 * only to re-measure settled geometry; it does not restart an entrance.
 */
function layoutItemStyle(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  return {
    orientation: value.orientation ?? null,
    description: value.description ?? null,
    gap: value.gap ?? null,
    minWidth: value.minWidth ?? null,
    descriptionAlign: value.descriptionAlign ?? null,
    valueAlign: value.valueAlign ?? null,
    descriptionSize: value.descriptionSize ?? null,
    valueSize: value.valueSize ?? null,
    descriptionBold: value.descriptionBold ?? null,
    valueBold: value.valueBold ?? null
  }
}

/**
 * Layout-only projection of sparse overrides. Colour edits must not restart a
 * reveal or force a re-measure; only the inner gap, the per-item lower width
 * and the two alignments can affect the measured/presented layout.
 */
function layoutItemStyles(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  const result: Record<string, unknown> = {}
  for (const [metric, style] of Object.entries(value)) {
    if (!isRecord(style)) continue
    const layout: Record<string, unknown> = {}
    if (style.gap !== undefined) layout.gap = style.gap
    if (style.minWidth !== undefined) layout.minWidth = style.minWidth
    if (style.descriptionAlign !== undefined) {
      layout.descriptionAlign = style.descriptionAlign
    }
    if (style.valueAlign !== undefined) layout.valueAlign = style.valueAlign
    if (Object.keys(layout).length > 0) result[metric] = layout
  }
  return result
}

export function kevinHudSizingKey(
  config: KevinHudSizingConfig | null | undefined
): string {
  const bounds = resolveKevinHudWidthBounds(config)
  const padding = resolveKevinHudContentPadding(config)
  return JSON.stringify({
    width: bounds.minWidth,
    maxWidth: bounds.maxWidth,
    auto: bounds.auto,
    height: measureKevinHudMinContentHeight(config),
    itemGap: resolveKevinHudItemGap(config),
    padding,
    fontScale: resolveKevinHudFontScale(config),
    borderWidth: pickNumber(
      config?.borderWidth,
      DEFAULT_KEVIN_HUD.borderWidth,
      KEVIN_HUD_LIMITS.borderWidth[0],
      KEVIN_HUD_LIMITS.borderWidth[1]
    ),
    itemStyle: layoutItemStyle(config?.itemStyle),
    itemStyles: layoutItemStyles(config?.itemStyles),
    metrics: config?.metrics ?? []
  })
}
