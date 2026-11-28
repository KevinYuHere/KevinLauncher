import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import {
  DEFAULT_KEVIN_HUD,
  DEFAULT_KEVIN_HUD_ITEM_STYLE,
  KEVIN_HUD_ITEM_STYLE_LIMITS,
  normalizeKevinHudConfig,
  normalizeKevinHudItemStyle,
  type KevinHudAnchor,
  type KevinHudBackgroundMode,
  type KevinHudConfig,
  type KevinHudDirection,
  type KevinHudItemAlign,
  type KevinHudItemDescription,
  type KevinHudItemOrientation,
  type KevinHudItemStyle,
  type KevinHudItemStyleOverride,
  type KevinHudItemStyles,
  type KevinHudMetric,
  type KevinHudMonitor,
  type KevinHudPositionMode
} from '@shared/kevinHud'
import { normalizeKevinHudGradient } from '@shared/kevinHudBackground'
import {
  KEVIN_HUD_MAX_ALLOWED_HEIGHT,
  KEVIN_HUD_MAX_ALLOWED_WIDTH,
  KEVIN_HUD_MAX_CONTENT_PADDING,
  KEVIN_HUD_MAX_ITEM_GAP,
  KEVIN_HUD_MIN_ALLOWED_HEIGHT,
  KEVIN_HUD_MIN_ALLOWED_WIDTH,
  measureKevinHudItemWidth,
  measureKevinHudMinContentHeight,
  measureKevinHudValueWidth,
  resolveKevinHudContentPadding,
  resolveKevinHudItemGap,
  resolveKevinHudWidthBounds
} from '@shared/kevinHudSizing'
import type { GlassMaterial } from '@shared/types'
import Checkbox from './Checkbox'
import Collapse from './Collapse'
import ColorPicker from './ColorPicker'
import HudRow from './KevinHudRow'
import Icon from './Icon'
import KevinHudCopySettings from './KevinHudCopySettings'
import KevinHudGradientEditor from './KevinHudGradientEditor'
import Segmented from './Segmented'
import Select from './Select'
import Sortable from './Sortable'
import SortableGrip from './SortableGrip'
import Switch from './Switch'
import '../assets/kevin-hud-settings.css'

export type HudItemOrientation = KevinHudItemOrientation
export type HudDescriptionMode = KevinHudItemDescription
export type HudItemStylePatch = Partial<KevinHudItemStyle>

/** The four item-layout fields that can be overridden per metric. */
export type HudLayoutField = 'minWidth' | 'gap' | 'descriptionAlign' | 'valueAlign'
export type HudItemLayoutStyle = Pick<KevinHudItemStyle, HudLayoutField>

/**
 * Settings-facing names for the shared HUD contract. The shared store owns
 * persistence and defaults; these aliases keep the editor readably typed while
 * old saved HUDs that predate a field are still accepted by normalization.
 */
export type HudSettingsConfig = KevinHudConfig

export type HudSettingsItemStyle = KevinHudItemStyle

export type HudStyleColorField = 'descriptionColor' | 'valueColor'
export type HudMetricStyleField = HudLayoutField | HudStyleColorField

/** The only per-metric overrides the editor exposes. */
export type HudMetricStyleOverride = KevinHudItemStyleOverride

type HudRecord = Record<string, unknown>

interface HudMetricInfo {
  id: KevinHudMetric
  label: string
  desc: string
  /** Settings hint describing what the reserved item width covers. */
  reserve: string
}

const HUD_DEFAULT_FOREGROUND_OPACITY = 1
const HUD_HEX_COLOR = /^#[\da-f]{6}$/i
const HUD_STYLE_COLOR_FIELDS: readonly HudStyleColorField[] = [
  'descriptionColor',
  'valueColor'
]

const HUD_ITEM_ALIGNS: readonly KevinHudItemAlign[] = ['left', 'center', 'right']
const HUD_LAYOUT_FIELDS: readonly HudLayoutField[] = [
  'minWidth',
  'gap',
  'descriptionAlign',
  'valueAlign'
]
const HUD_ITEM_MIN_WIDTH_RANGE = KEVIN_HUD_ITEM_STYLE_LIMITS.minWidth
const HUD_ITEM_STYLE_GAP_LIMITS = KEVIN_HUD_ITEM_STYLE_LIMITS.gap

/** Different label sets would make the same saved alignment read differently. */
export const HUD_ITEM_ALIGN_OPTIONS: readonly {
  value: KevinHudItemAlign
  label: string
}[] = [
  { value: 'left', label: '左' },
  { value: 'center', label: '中' },
  { value: 'right', label: '右' }
]

/** Upper bound mirrors the shared per-item `minWidth` contract. */
export const HUD_ITEM_MIN_WIDTH_MAX = HUD_ITEM_MIN_WIDTH_RANGE[1]

/** Quiet light-white the reference HUD uses for the small descriptor. */
export const HUD_REFERENCE_DESCRIPTION_COLOR = '#D8D6D3'
/** The reference value colour; automatic values stay white. */
export const HUD_REFERENCE_VALUE_COLOR = '#FFFFFF'

const isHudRecord = (value: unknown): value is HudRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function isHudHexColor(value: unknown): value is string {
  return typeof value === 'string' && HUD_HEX_COLOR.test(value.trim())
}

export function isHudItemAlign(value: unknown): value is KevinHudItemAlign {
  return typeof value === 'string' &&
    (HUD_ITEM_ALIGNS as readonly string[]).includes(value)
}

const normalizeHudMinWidth = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(HUD_ITEM_MIN_WIDTH_RANGE[1], Math.max(HUD_ITEM_MIN_WIDTH_RANGE[0], value))
    : undefined

const normalizeHudItemGap = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(
        HUD_ITEM_STYLE_GAP_LIMITS[1],
        Math.max(HUD_ITEM_STYLE_GAP_LIMITS[0], value)
      )
    : undefined

/**
 * Read the four layout defaults/effective values from any style snapshot.
 *
 * `minWidth: 0` means "no extra width": the content's measured width still
 * applies. `gap` is the minimum descriptor/value distance in both orientations;
 * alignment only distributes space inside a wider slot and never moves one
 * block over the other.
 */
export function readHudItemLayout(value: unknown): HudItemLayoutStyle {
  const source = isHudRecord(value) ? value : {}
  return {
    minWidth:
      normalizeHudMinWidth(source.minWidth) ??
      DEFAULT_KEVIN_HUD_ITEM_STYLE.minWidth,
    gap: normalizeHudItemGap(source.gap) ?? DEFAULT_KEVIN_HUD_ITEM_STYLE.gap,
    descriptionAlign: isHudItemAlign(source.descriptionAlign)
      ? source.descriptionAlign
      : DEFAULT_KEVIN_HUD_ITEM_STYLE.descriptionAlign,
    valueAlign: isHudItemAlign(source.valueAlign)
      ? source.valueAlign
      : DEFAULT_KEVIN_HUD_ITEM_STYLE.valueAlign
  }
}

/** True when a saved per-item override actually owns this layout field. */
export function hasHudItemStyleField(
  value: unknown,
  field: HudLayoutField
): boolean {
  if (!isHudRecord(value) || !Object.hasOwn(value, field)) return false
  switch (field) {
    case 'minWidth':
      return normalizeHudMinWidth(value[field]) !== undefined
    case 'gap':
      return normalizeHudItemGap(value[field]) !== undefined
    case 'descriptionAlign':
    case 'valueAlign':
      return isHudItemAlign(value[field])
    default:
      return false
  }
}

/** Foreground opacity; historical whole-HUD configs migrate through the shared normalizer. */
export function normalizeHudForegroundOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return HUD_DEFAULT_FOREGROUND_OPACITY
  }
  return Math.min(1, Math.max(0, value))
}

/**
 * Read only the persistence fields the per-item editor is allowed to own.
 *
 * Older Beta builds saved a per-item orientation, size or weight. Those fields
 * are deliberately ignored instead of being copied into the new unified style;
 * valid layout/colour overrides survive.
 */
export function sanitizeHudMetricStyleOverride(
  value: unknown,
  fallback?: unknown
): HudMetricStyleOverride {
  const primary = isHudRecord(value) ? value : {}
  const secondary = isHudRecord(fallback) ? fallback : {}
  const result: HudMetricStyleOverride = {}

  const minWidth = normalizeHudMinWidth(primary.minWidth ?? secondary.minWidth)
  if (minWidth !== undefined) result.minWidth = minWidth
  const gap = normalizeHudItemGap(primary.gap ?? secondary.gap)
  if (gap !== undefined) result.gap = gap
  for (const field of ['descriptionAlign', 'valueAlign'] as const) {
    const alignment = primary[field] ?? secondary[field]
    if (isHudItemAlign(alignment)) result[field] = alignment
  }
  for (const field of HUD_STYLE_COLOR_FIELDS) {
    const explicit = primary[field]
    if (explicit === null) continue
    if (isHudHexColor(explicit)) {
      result[field] = explicit.trim()
      continue
    }
    const inherited = secondary[field]
    if (isHudHexColor(inherited)) result[field] = inherited.trim()
  }
  return result
}

/** Keep sparse allowed overrides for every selected/legacy metric. */
export function sanitizeHudItemStyles(
  value: unknown,
  fallback?: unknown
): KevinHudItemStyles {
  const primary = isHudRecord(value) ? value : {}
  const secondary = isHudRecord(fallback) ? fallback : {}
  const metrics = new Set<string>([...Object.keys(secondary), ...Object.keys(primary)])
  const result: KevinHudItemStyles = {}
  for (const metric of metrics) {
    if (!HUD_METRIC_BY_ID.has(metric as KevinHudMetric)) continue
    const override = sanitizeHudMetricStyleOverride(primary[metric], secondary[metric])
    if (Object.keys(override).length > 0) {
      result[metric as KevinHudMetric] = override
    }
  }
  return result
}

/**
 * Complete settings snapshot used by the editor. The shared normalizer is the
 * one writer of defaults, ranges and legacy per-item cleanup; this wrapper
 * keeps the editor's named snapshot type in one place and re-applies the
 * settings-page metric guard so drafts never expose the retired icon id.
 */
export function normalizeHudSettings(value: unknown): HudSettingsConfig {
  const normalized = normalizeKevinHudConfig(value)
  return {
    ...normalized,
    metrics: sanitizeHudMetrics(normalized.metrics),
    itemStyles: sanitizeHudItemStyles(normalized.itemStyles)
  }
}

/** A metric's allowed override from a possibly older saved HUD. */
export function getHudMetricStyleOverride(
  itemStyles: unknown,
  metric: KevinHudMetric
): HudMetricStyleOverride {
  if (!isHudRecord(itemStyles)) return {}
  return sanitizeHudMetricStyleOverride(itemStyles[metric])
}

/** Clear one allowed override, removing the metric entirely when it is empty. */
export function clearHudMetricStyleField(
  itemStyles: KevinHudItemStyles | undefined,
  metric: KevinHudMetric,
  field: HudMetricStyleField
): KevinHudItemStyles {
  const next = { ...(itemStyles ?? {}) }
  const current = next[metric]
  if (!current) return next
  const copy = { ...current } as Record<string, unknown>
  delete copy[field]
  if (Object.keys(copy).length === 0) delete next[metric]
  else next[metric] = copy as Partial<KevinHudItemStyle>
  return next
}

/** One saved app offered by the copy-settings picker. */
export interface HudCopySource {
  id: string
  name: string
  config: HudSettingsConfig
}

export interface HudCopySourceApp {
  id: string
  name: string
  kevinHud?: unknown
}

/**
 * Candidate builder for the copy picker. It excludes the app being edited,
 * ignores duplicate/malformed entries, and normalizes each source snapshot so
 * the caller never shares mutable objects with the application list.
 */
export function buildHudCopySources(
  apps: readonly HudCopySourceApp[],
  currentAppId: string
): HudCopySource[] {
  const seen = new Set<string>([currentAppId])
  const sources: HudCopySource[] = []
  for (const app of apps) {
    if (!app || typeof app.id !== 'string' || !app.id.trim()) continue
    if (seen.has(app.id)) continue
    seen.add(app.id)
    const name =
      typeof app.name === 'string' && app.name.trim() ? app.name.trim() : '未命名应用'
    sources.push({
      id: app.id,
      name,
      config: normalizeHudSettings(app.kevinHud ?? {})
    })
  }
  return sources
}

/** Deep, independent normalized copy of a source HUD for the current app. */
export function cloneHudSettingsForCopy(value: unknown): HudSettingsConfig {
  return normalizeHudSettings(value)
}

export interface HudCopyPlan {
  config: HudSettingsConfig
  /** A newer revision that supersedes any queued debounce. */
  revision: number
  /** Copy always uses the immediate save path. */
  immediate: true
}

/**
 * Plan a copy as an immediate, newer save. The component clears the pending
 * debounce slot for the target app before flushing this plan, so an older
 * slider update can never land after the copied settings.
 */
export function planHudCopyApply(
  source: unknown,
  currentRevision: number
): HudCopyPlan {
  return {
    config: cloneHudSettingsForCopy(source),
    revision: currentRevision + 1,
    immediate: true
  }
}

/**
 * UI bounds mirror the shared config guard. The shared normalizer remains the
 * only writer, so these values only shape the controls and never redefine the
 * persisted contract.
 */
export const HUD_WIDTH_MIN = KEVIN_HUD_MIN_ALLOWED_WIDTH
export const HUD_WIDTH_MAX = KEVIN_HUD_MAX_ALLOWED_WIDTH
export const HUD_HEIGHT_MIN = KEVIN_HUD_MIN_ALLOWED_HEIGHT
export const HUD_HEIGHT_MAX = KEVIN_HUD_MAX_ALLOWED_HEIGHT
export const HUD_ITEM_GAP_MAX = KEVIN_HUD_MAX_ITEM_GAP
export const HUD_CONTENT_PADDING_MAX = KEVIN_HUD_MAX_CONTENT_PADDING
export const DEFAULT_HUD_ITEM_STYLE = DEFAULT_KEVIN_HUD_ITEM_STYLE

const HUD_ITEM_GAP_RANGE = [0, HUD_ITEM_GAP_MAX] as const
const HUD_CONTENT_PADDING_RANGE = [0, HUD_CONTENT_PADDING_MAX] as const
const HUD_ITEM_DESCRIPTION_SIZE_RANGE = KEVIN_HUD_ITEM_STYLE_LIMITS.descriptionSize
const HUD_ITEM_VALUE_SIZE_RANGE = KEVIN_HUD_ITEM_STYLE_LIMITS.valueSize

/** Built-in global defaults, also used by reset and per-item "follow" copy. */
export const HUD_ITEM_LAYOUT_DEFAULTS: HudItemLayoutStyle = {
  minWidth: DEFAULT_HUD_ITEM_STYLE.minWidth,
  gap: DEFAULT_HUD_ITEM_STYLE.gap,
  descriptionAlign: DEFAULT_HUD_ITEM_STYLE.descriptionAlign,
  valueAlign: DEFAULT_HUD_ITEM_STYLE.valueAlign
}

/** Remove one metric override without touching the shared global default. */
export function clearHudMetricItemStyle(
  itemStyles: KevinHudItemStyles | undefined,
  metric: KevinHudMetric
): KevinHudItemStyles {
  const next = { ...(itemStyles ?? {}) }
  delete next[metric]
  return next
}

/**
 * Labels are intentionally kept in the renderer: the shared module owns the
 * metric ids and ordering contract, while the Chinese UI copy belongs here.
 */
export const HUD_METRIC_INFO: readonly HudMetricInfo[] = [
  {
    id: 'appName',
    label: '应用图标与名称',
    desc: '图标在说明位置，名称在数值位置；名称太长时会在 HUD 里滚动，不会被裁掉',
    reserve: '说明固定为真实应用图标（没有图标时用现有回退），数值固定为实际应用名称'
  },
  {
    id: 'sessionTime',
    label: '本次时长',
    desc: '本次启动后的运行时长',
    reserve: '最长会话时长'
  },
  {
    id: 'totalTime',
    label: '累计时长',
    desc: '该应用的累计使用时长',
    reserve: '最长累计时长'
  },
  {
    id: 'fps',
    label: 'FPS',
    desc: '帧率；不可用时显示 --',
    reserve: '最大帧率'
  },
  {
    id: 'gpu',
    label: 'GPU',
    desc: '显卡占用 / 温度；不可用时显示 --',
    reserve: '占用与温度'
  },
  {
    id: 'cpu',
    label: 'CPU',
    desc: '处理器占用；不可用时显示 --',
    reserve: '最大占用'
  },
  {
    id: 'memory',
    label: '内存',
    desc: '内存占用；不可用时显示 --',
    reserve: '已用 / 总量 / 百分比'
  },
  {
    id: 'download',
    label: '下载速度',
    desc: '网络下载速率；不可用时显示 --',
    reserve: '最大下载速率'
  },
  {
    id: 'upload',
    label: '上传速度',
    desc: '网络上传速率；不可用时显示 --',
    reserve: '最大上传速率'
  },
  {
    id: 'clock',
    label: '时钟',
    desc: '当前系统时间',
    reserve: '当前系统时间'
  }
]

const HUD_METRIC_BY_ID = new Map<KevinHudMetric, HudMetricInfo>(
  HUD_METRIC_INFO.map((metric) => [metric.id, metric])
)

const DIRECTION_OPTIONS: { value: KevinHudDirection; label: string }[] = [
  { value: 'center', label: '居中' },
  { value: 'left', label: '左侧' },
  { value: 'right', label: '右侧' },
  { value: 'top', label: '上方' },
  { value: 'bottom', label: '下方' }
]

const POSITION_OPTIONS: { value: KevinHudPositionMode; label: string }[] = [
  { value: 'preset', label: '顶部居中' },
  { value: 'custom', label: '手动位置' }
]

const ANCHOR_OPTIONS: { value: KevinHudAnchor; label: string }[] = [
  { value: 'left', label: '左' },
  { value: 'center', label: '中' },
  { value: 'right', label: '右' }
]

const BACKGROUND_OPTIONS: { value: KevinHudBackgroundMode; label: string }[] = [
  { value: 'solid', label: '纯色' },
  { value: 'gradient', label: '渐变色' },
  { value: 'app', label: '应用外观' },
  { value: 'custom', label: '自定义' }
]

const MONITOR_OPTIONS: { value: KevinHudMonitor; label: string }[] = [
  { value: 'primary', label: '主显示器' },
  { value: 'game', label: '游戏所在屏' }
]

type HudOverflowMode = 'grow' | 'scroll'

/**
 * The persisted boolean is kept for compatibility: `autoWidth` means grow the
 * HUD from the configured minimum width, while `false` means keep that width
 * fixed and scroll the single metric row inside it.
 */
const OVERFLOW_OPTIONS: { value: HudOverflowMode; label: string }[] = [
  { value: 'grow', label: '加宽 HUD' },
  { value: 'scroll', label: '横向滚动' }
]

const MATERIAL_OPTIONS: { value: GlassMaterial; label: string }[] = [
  { value: 'blur', label: '毛玻璃' },
  { value: 'mica', label: '云母' },
  { value: 'liquid', label: '液态' },
  { value: 'shine', label: '高光' },
  { value: 'starfrost', label: '星霜' },
  { value: 'astral', label: '星轨' }
]

const SAMPLE_SECONDS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]

export type HudColorField = 'background' | 'border' | 'text' | 'icon'

/** One stable panel id per colour trigger; only the active field is expanded. */
const COLOR_EDITOR_IDS: Record<HudColorField, string> = {
  border: 'kevin-hud-border-color-editor',
  background: 'kevin-hud-background-color-editor',
  text: 'kevin-hud-text-color-editor',
  icon: 'kevin-hud-icon-color-editor'
}

/**
 * The settings page can show several colour panels (background, text, the
 * shared style and every selected item). A single target object makes exactly
 * one of them the expanded instance, including when two metrics use the same
 * field name.
 */
export type HudColorTarget =
  | { kind: 'config'; field: HudColorField }
  | { kind: 'defaultStyle'; field: HudStyleColorField }
  | { kind: 'metricStyle'; metric: KevinHudMetric; field: HudStyleColorField }

export function hudColorTargetKey(target: HudColorTarget): string {
  if (target.kind === 'config') return `config-${target.field}`
  if (target.kind === 'defaultStyle') return `default-${target.field}`
  return `metric-${target.metric}-${target.field}`
}

export function hudColorTargetPanelId(target: HudColorTarget): string {
  if (target.kind === 'config') return COLOR_EDITOR_IDS[target.field]
  return `kevin-hud-style-color-${hudColorTargetKey(target)}`
}

export function sameHudColorTarget(
  left: HudColorTarget | null,
  right: HudColorTarget | null
): boolean {
  return !!left && !!right && hudColorTargetKey(left) === hudColorTargetKey(right)
}

function isHudStyleColorOpen(
  active: HudColorTarget | null,
  kind: 'defaultStyle' | 'metricStyle',
  metric: KevinHudMetric | null,
  field: HudStyleColorField
): boolean {
  if (!active || active.kind !== kind) return false
  if (kind === 'metricStyle' && active.kind === 'metricStyle') {
    return active.metric === metric && active.field === field
  }
  return active.field === field
}

const LABELS: Record<KevinHudBackgroundMode, { name: string; desc: string; color: string }> = {
  solid: {
    name: '纯色',
    desc: '使用下面选择的纯色底；纯色不叠加材质',
    color: '背景颜色'
  },
  gradient: {
    name: '渐变色',
    desc: '用多个色标过渡；渐变不使用纯色底色和材质',
    color: '背景颜色（渐变色使用渐变色标）'
  },
  app: {
    name: '应用外观',
    desc: '沿用这个应用现在的主题与玻璃效果',
    color: '背景颜色（应用外观下不生效）'
  },
  custom: {
    name: '自定义',
    desc: '自己选择底色，可再叠一层所选材质',
    color: '背景颜色'
  }
}

/**
 * Old HUDs could select the app icon and the app name as two separate rows.
 * The settled HUD now has one merged app-identity item under `appName`, so
 * `appIcon` is accepted only while reading legacy data and is never written
 * back as a metric of its own.
 */
const LEGACY_HUD_METRIC_ALIASES: Readonly<Record<string, KevinHudMetric>> = {
  appIcon: 'appName'
}

function canonicalHudMetric(value: unknown): KevinHudMetric | null {
  if (typeof value !== 'string') return null
  const id = LEGACY_HUD_METRIC_ALIASES[value] ?? value
  return HUD_METRIC_BY_ID.has(id as KevinHudMetric) ? (id as KevinHudMetric) : null
}

/** Keep only known metric ids, map legacy aliases, de-duplicate and keep order. */
export function sanitizeHudMetrics(metrics: readonly unknown[]): KevinHudMetric[] {
  const seen = new Set<KevinHudMetric>()
  const result: KevinHudMetric[] = []
  for (const value of metrics) {
    const metric = canonicalHudMetric(value)
    if (!metric || seen.has(metric)) continue
    seen.add(metric)
    result.push(metric)
  }
  return result
}

/** Add a metric at the end of the list, or remove it if disabled. */
export function setHudMetricEnabled(
  metrics: readonly unknown[],
  metric: KevinHudMetric,
  enabled: boolean
): KevinHudMetric[] {
  const current = sanitizeHudMetrics(metrics)
  if (enabled) return current.includes(metric) ? current : [...current, metric]
  return current.filter((id) => id !== metric)
}

/** Re-apply a dragged/keyboard order; ids that disappeared are dropped safely. */
export function reorderHudMetrics(metrics: readonly unknown[], ids: readonly string[]): KevinHudMetric[] {
  const current = sanitizeHudMetrics(metrics)
  const known = new Set(current)
  const ordered: KevinHudMetric[] = []
  for (const value of ids) {
    const id = canonicalHudMetric(value)
    if (!id || !known.has(id)) continue
    known.delete(id)
    ordered.push(id)
  }
  for (const id of current) {
    if (!known.has(id)) continue
    known.delete(id)
    ordered.push(id)
  }
  return ordered
}

/** Trim a user-entered accelerator; empty means "not bound". */
export function normalizeHudHotkey(value: string | null | undefined): string | null {
  const hotkey = (value ?? '').trim()
  return hotkey ? hotkey : null
}

/** Clamp a numeric field, falling back to `fallback` only for non-finite input. */
export function clampHudNumber(value: number, min: number, max: number, fallback = min): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * A colour editor is only visible while its row is still editable. This is
 * derived during render, so switching to app / auto / original cannot leave a
 * stale panel expanded for a frame before an effect runs.
 */
export function resolveActiveColorField(
  field: HudColorField | null,
  {
    backgroundIsApp,
    backgroundIsGradient = false,
    textIsAuto,
    iconIsOriginal
  }: {
    backgroundIsApp: boolean
    backgroundIsGradient?: boolean
    textIsAuto: boolean
    iconIsOriginal: boolean
  }
): HudColorField | null {
  if (field === 'background' && (backgroundIsApp || backgroundIsGradient)) return null
  if (field === 'text' && textIsAuto) return null
  if (field === 'icon' && iconIsOriginal) return null
  return field
}

/** Fresh, normalized defaults for the reset action (it is always saved). */
export function resetHudConfig(): HudSettingsConfig {
  return normalizeHudSettings(DEFAULT_KEVIN_HUD)
}

function formatNumber(value: number, digits = 0): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(digits)
}

function formatHudColor(value: string | null): string {
  return value ? value.toUpperCase() : ''
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

/**
 * Pause the two decorative header animations when the launcher window is not
 * visible or focused. Initial SSR markup is paused, so rendering the settings
 * cannot start an animation before the page is actually on screen.
 */
function useHudHeaderMotion(): boolean {
  const [active, setActive] = useState(false)

  useEffect(() => {
    let mounted = true
    const sync = (): void => {
      if (!mounted) return
      setActive(!document.hidden && document.hasFocus())
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    window.addEventListener('pageshow', sync)
    return () => {
      mounted = false
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      window.removeEventListener('pageshow', sync)
    }
  }, [])

  return active
}

function ColorEditorPanel({
  id,
  open,
  label,
  color,
  header,
  panelClassName = '',
  onChange
}: {
  id: string
  open: boolean
  label: string
  color: string
  header: ReactNode
  panelClassName?: string
  onChange: (hex: string) => void
}): ReactElement {
  return (
    <Collapse open={open} header={header}>
      <div
        className={`settings-color-panel${panelClassName ? ` ${panelClassName}` : ''}`}
        id={id}
        role="group"
        aria-label={label}
      >
        {open && <ColorPicker value={color} onChange={onChange} />}
      </div>
    </Collapse>
  )
}

/**
 * One editable colour row. The trigger and the panel header are the same row,
 * so an expanded picker always appears directly under the field it changes.
 * When no override is stored, the effective inherited colour is still shown.
 */
function StyleColorRow({
  target,
  label,
  contextLabel,
  readout,
  color,
  inherit,
  inheritLabel,
  open,
  onToggle,
  onChange,
  onInherit
}: {
  target: HudColorTarget
  label: string
  /** e.g. "统一" or the metric name; keeps peer colour controls distinct. */
  contextLabel: string
  readout: string
  color: string
  inherit: boolean
  inheritLabel: string
  open: boolean
  onToggle: () => void
  onChange: (hex: string) => void
  onInherit: () => void
}): ReactElement {
  const panelId = hudColorTargetPanelId(target)
  const targetKey = hudColorTargetKey(target)
  const accessibleLabel = `${contextLabel}${label}`
  return (
    <ColorEditorPanel
      id={panelId}
      open={open}
      label={`${accessibleLabel}调色板`}
      color={color}
      panelClassName="kh-style-color-panel"
      onChange={onChange}
      header={
        <div className="kh-style-color-row">
          <div className="kh-style-color-main">
            <span className="kh-style-field-label">{label}</span>
            <span className="kh-style-color-readout">{readout}</span>
          </div>
          <div className="kh-style-color-actions">
            <Switch
              checked={inherit}
              label={inheritLabel}
              title={
                inherit
                  ? `取消${inheritLabel}，为这个位置单独选色`
                  : `恢复${inheritLabel}，不再单独选色`
              }
              onChange={(next) => {
                if (next) onInherit()
                else onChange(color)
              }}
            />
            <button
              type="button"
              className="color-trigger"
              title={`选择${accessibleLabel}`}
              aria-label={`选择${accessibleLabel}`}
              aria-expanded={open}
              aria-controls={panelId}
              data-color-target={targetKey}
              data-color-open={open ? 'true' : 'false'}
              onClick={onToggle}
            >
              <span className="kh-color-swatch" style={{ background: color }} />
            </button>
            {!inherit && (
              <button
                type="button"
                className="btn sm ghost"
                title={`恢复${inheritLabel === '跟随统一' ? '统一' : inheritLabel}`}
                onClick={onInherit}
              >
                恢复{inheritLabel === '跟随统一' ? '统一' : inheritLabel}
              </button>
            )}
          </div>
        </div>
      }
    />
  )
}

function NumericField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  disabled,
  ariaLabel,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  disabled?: boolean
  ariaLabel?: string
  onChange: (value: number) => void
}): ReactElement {
  const [text, setText] = useState(String(value))
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setText(String(value))
  }, [value, editing])

  const commit = (): void => {
    const parsed = Number(text.replace(',', '.'))
    const next = clampHudNumber(parsed, min, max, value)
    setText(String(next))
    if (next !== value) onChange(next)
  }

  return (
    <label className="kh-num">
      <span className="kh-num-label">{label}</span>
      <span className="kh-num-box">
        <input
          className="input kh-num-input"
          type="number"
          value={text}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-label={ariaLabel ?? label}
          onFocus={() => setEditing(true)}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            setEditing(false)
            commit()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur()
            } else if (event.key === 'Escape') {
              setText(String(value))
              event.currentTarget.blur()
            }
          }}
        />
        {unit && <span className="kh-num-unit">{unit}</span>}
      </span>
    </label>
  )
}

function RangeRow({
  name,
  desc,
  value,
  min,
  max,
  step = 1,
  disabled,
  display,
  onChange
}: {
  name: string
  desc?: string
  value: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  display: (value: number) => string
  onChange: (value: number) => void
}): ReactElement {
  return (
    <HudRow
      name={name}
      desc={desc}
      action={
        <div className="range-row">
          <span className="range-value">{display(value)}</span>
          <input
            className="slider"
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            aria-label={name}
            onChange={(event) => onChange(Number(event.target.value))}
          />
        </div>
      }
    />
  )
}

function ToggleRow({
  name,
  desc,
  checked,
  disabled,
  label,
  title,
  onChange
}: {
  name: string
  desc: string
  checked: boolean
  disabled?: boolean
  label: string
  title?: string
  onChange: (checked: boolean) => void
}): ReactElement {
  return (
    <HudRow
      name={name}
      desc={desc}
      action={
        <Switch
          checked={checked}
          disabled={disabled}
          label={label}
          title={title ?? name}
          onChange={onChange}
        />
      }
    />
  )
}

const ITEM_ORIENTATION_OPTIONS: { value: HudItemOrientation; label: string }[] = [
  { value: 'horizontal', label: '水平排列' },
  { value: 'vertical', label: '垂直排列' }
]

const ITEM_DESCRIPTION_OPTIONS: { value: HudDescriptionMode; label: string }[] = [
  { value: 'text', label: '文字' },
  { value: 'icon', label: '图标' }
]

function formatStyleNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function StyleFieldRow({
  label,
  children
}: {
  label: string
  children: ReactNode
}): ReactElement {
  return (
    <div className="kh-style-field-row">
      <span className="kh-style-field-label">{label}</span>
      <div className="kh-style-field-control">{children}</div>
    </div>
  )
}

/**
 * Short explanation shared by both drawers: 0 keeps natural content width, the
 * gap is a minimum on either axis, and alignments never move one block over the
 * other. Both-centred horizontal items keep the pair together as one group.
 */
const HUD_LAYOUT_HINT =
  '最小宽度 0 表示不预留，数值仍按实际内容撑开；最小间隔在横排和竖排都生效。横排说明和数值都居中时整组居中且不重叠，竖排则各自对齐。'

const HUD_LAYOUT_NUMBER_META = {
  minWidth: {
    label: '子项最小宽度',
    min: HUD_ITEM_MIN_WIDTH_RANGE[0],
    max: HUD_ITEM_MIN_WIDTH_RANGE[1]
  },
  gap: {
    label: '说明与数值最小间隔',
    min: HUD_ITEM_STYLE_GAP_LIMITS[0],
    max: HUD_ITEM_STYLE_GAP_LIMITS[1]
  }
} as const

const HUD_LAYOUT_ALIGN_META = {
  descriptionAlign: { label: '说明对齐' },
  valueAlign: { label: '数值对齐' }
} as const

const EMPTY_HUD_LAYOUT_OVERRIDES: ReadonlySet<HudLayoutField> = new Set()

function formatHudLayoutValue(
  field: HudLayoutField,
  layout: HudItemLayoutStyle
): string {
  if (field === 'minWidth' || field === 'gap') {
    return `${formatNumber(layout[field])} px`
  }
  const alignment = layout[field]
  return HUD_ITEM_ALIGN_OPTIONS.find((option) => option.value === alignment)?.label ?? '左'
}

/**
 * Per-field "follow unified" state for one item. The control itself already
 * shows the effective value, so the note only needs to say where it came from.
 */
function LayoutFollowStatus({
  field,
  fieldLabel,
  base,
  overridden,
  onFollow
}: {
  field: HudLayoutField
  fieldLabel: string
  base: HudItemLayoutStyle
  overridden: boolean
  onFollow: () => void
}): ReactElement {
  return (
    <>
      <span className="kh-style-inherit-note">
        {overridden
          ? '仅此指标'
          : `跟随统一 · ${formatHudLayoutValue(field, base)}`}
      </span>
      {overridden && (
        <button
          type="button"
          className="btn sm ghost"
          title={`恢复统一的${fieldLabel}`}
          onClick={onFollow}
        >
          跟随统一
        </button>
      )}
    </>
  )
}

function HudLayoutNumberField({
  field,
  contextLabel,
  layout,
  base,
  overridden,
  onPatch,
  onFollow
}: {
  field: 'minWidth' | 'gap'
  contextLabel: string
  layout: HudItemLayoutStyle
  base?: HudItemLayoutStyle
  overridden: boolean
  onPatch: (patch: HudItemStylePatch) => void
  onFollow?: () => void
}): ReactElement {
  const meta = HUD_LAYOUT_NUMBER_META[field]
  return (
    <>
      <NumericField
        label={meta.label}
        ariaLabel={`${contextLabel}${meta.label}`}
        unit="px"
        value={layout[field]}
        min={meta.min}
        max={meta.max}
        step={1}
        onChange={(value) =>
          onPatch(field === 'minWidth' ? { minWidth: value } : { gap: value })
        }
      />
      {base && onFollow && (
        <LayoutFollowStatus
          field={field}
          fieldLabel={meta.label}
          base={base}
          overridden={overridden}
          onFollow={onFollow}
        />
      )}
    </>
  )
}

function HudLayoutAlignField({
  field,
  contextLabel,
  layout,
  base,
  overridden,
  onPatch,
  onFollow
}: {
  field: 'descriptionAlign' | 'valueAlign'
  contextLabel: string
  layout: HudItemLayoutStyle
  base?: HudItemLayoutStyle
  overridden: boolean
  onPatch: (patch: HudItemStylePatch) => void
  onFollow?: () => void
}): ReactElement {
  const meta = HUD_LAYOUT_ALIGN_META[field]
  return (
    <StyleFieldRow label={meta.label}>
      <Segmented
        value={layout[field]}
        options={[...HUD_ITEM_ALIGN_OPTIONS]}
        title={`${contextLabel}${meta.label}`}
        onChange={(value) =>
          onPatch(
            field === 'descriptionAlign'
              ? { descriptionAlign: value as KevinHudItemAlign }
              : { valueAlign: value as KevinHudItemAlign }
          )
        }
      />
      {base && onFollow && (
        <LayoutFollowStatus
          field={field}
          fieldLabel={meta.label}
          base={base}
          overridden={overridden}
          onFollow={onFollow}
        />
      )}
    </StyleFieldRow>
  )
}

/**
 * The one layout editor used by both the unified drawer and every item drawer.
 * The unified instance seeds the defaults; an item instance shows the effective
 * value and can restore any of the four fields independently.
 */
function HudLayoutFields({
  contextLabel,
  layout,
  base,
  overridden = EMPTY_HUD_LAYOUT_OVERRIDES,
  onPatch,
  onFollow
}: {
  contextLabel: string
  layout: HudItemLayoutStyle
  base?: HudItemLayoutStyle
  overridden?: ReadonlySet<HudLayoutField>
  onPatch: (patch: HudItemStylePatch) => void
  onFollow?: (field: HudLayoutField) => void
}): ReactElement {
  const numberField = (field: 'minWidth' | 'gap'): ReactElement => (
    <HudLayoutNumberField
      field={field}
      contextLabel={contextLabel}
      layout={layout}
      base={base}
      overridden={overridden.has(field)}
      onPatch={onPatch}
      onFollow={onFollow ? () => onFollow(field) : undefined}
    />
  )
  const alignField = (
    field: 'descriptionAlign' | 'valueAlign'
  ): ReactElement => (
    <HudLayoutAlignField
      field={field}
      contextLabel={contextLabel}
      layout={layout}
      base={base}
      overridden={overridden.has(field)}
      onPatch={onPatch}
      onFollow={onFollow ? () => onFollow(field) : undefined}
    />
  )

  return (
    <>
      {base ? (
        <>
          <div className="kh-metric-style-gap">{numberField('minWidth')}</div>
          <div className="kh-metric-style-gap">{numberField('gap')}</div>
        </>
      ) : (
        <div className="kh-style-grid">
          {numberField('minWidth')}
          {numberField('gap')}
        </div>
      )}
      {alignField('descriptionAlign')}
      {alignField('valueAlign')}
      <div className="kh-style-inherit-note">{HUD_LAYOUT_HINT}</div>
    </>
  )
}

function defaultStyleColorTarget(field: HudStyleColorField): HudColorTarget {
  return { kind: 'defaultStyle', field }
}

function metricStyleColorTarget(
  metric: KevinHudMetric,
  field: HudStyleColorField
): HudColorTarget {
  return { kind: 'metricStyle', metric, field }
}

function styleColorReadout(
  field: HudStyleColorField,
  value: string | null
): string {
  if (value) return `自定义 · ${formatHudColor(value)}`
  return field === 'descriptionColor' ? '自动 · 浅白' : '自动 · 白色'
}

/**
 * The one unified editor for every value item: orientation, description form,
 * type sizes/weights and the shared colours. A selected item never duplicates
 * these controls; it can only add the small overrides in `MetricStyleEditor`.
 */
function UnifiedItemStyleEditor({
  metricLabel,
  itemStyle,
  activeColor,
  onToggleColor,
  onChange,
  onChangeColor,
  onReset
}: {
  metricLabel: string
  itemStyle: HudSettingsItemStyle
  activeColor: HudColorTarget | null
  onToggleColor: (target: HudColorTarget) => void
  onChange: (patch: HudItemStylePatch) => void
  onChangeColor: (field: HudStyleColorField, value: string | null) => void
  onReset: () => void
}): ReactElement {
  const descriptionFallback =
    itemStyle.descriptionColor ?? HUD_REFERENCE_DESCRIPTION_COLOR
  const valueFallback = itemStyle.valueColor ?? HUD_REFERENCE_VALUE_COLOR
  const layout = readHudItemLayout(itemStyle)

  return (
    <div className="kh-style-editor">
      <div className="kh-style-intro">
        <div>
          排列、说明形式、字号、粗细和颜色由所有指标共用；下面的最小宽度、最小间隔和对齐先作为默认值，单个指标可以覆盖后再恢复跟随。
        </div>
      </div>

      <div className="kh-style-controls">
        <StyleFieldRow label="排列">
          <Segmented
            value={itemStyle.orientation}
            options={ITEM_ORIENTATION_OPTIONS}
            title={`${metricLabel}排列方向`}
            onChange={(value) => onChange({ orientation: value as HudItemOrientation })}
          />
        </StyleFieldRow>

        <StyleFieldRow label="说明形式">
          <Segmented
            value={itemStyle.description}
            options={ITEM_DESCRIPTION_OPTIONS}
            title={`${metricLabel}说明形式`}
            onChange={(value) => onChange({ description: value as HudDescriptionMode })}
          />
        </StyleFieldRow>

        <div className="kh-style-grid">
          <NumericField
            label="说明字号"
            ariaLabel={`${metricLabel}说明字号`}
            unit="px"
            value={itemStyle.descriptionSize}
            min={HUD_ITEM_DESCRIPTION_SIZE_RANGE[0]}
            max={HUD_ITEM_DESCRIPTION_SIZE_RANGE[1]}
            step={0.5}
            onChange={(descriptionSize) => onChange({ descriptionSize })}
          />
          <NumericField
            label="数值字号"
            ariaLabel={`${metricLabel}数值字号`}
            unit="px"
            value={itemStyle.valueSize}
            min={HUD_ITEM_VALUE_SIZE_RANGE[0]}
            max={HUD_ITEM_VALUE_SIZE_RANGE[1]}
            step={0.5}
            onChange={(valueSize) => onChange({ valueSize })}
          />
        </div>

        <HudLayoutFields
          contextLabel={metricLabel}
          layout={layout}
          onPatch={onChange}
        />

        <div className="kh-style-toggles">
          <Switch
            checked={itemStyle.descriptionBold}
            label="说明加粗"
            title={`${metricLabel}说明是否加粗`}
            onChange={(descriptionBold) => onChange({ descriptionBold })}
          />
          <Switch
            checked={itemStyle.valueBold}
            label="数值加粗"
            title={`${metricLabel}数值是否加粗`}
            onChange={(valueBold) => onChange({ valueBold })}
          />
        </div>

        <StyleColorRow
          target={defaultStyleColorTarget('descriptionColor')}
          label="说明颜色"
          contextLabel="统一"
          readout={styleColorReadout('descriptionColor', itemStyle.descriptionColor)}
          color={descriptionFallback}
          inherit={itemStyle.descriptionColor === null}
          inheritLabel="自动"
          open={isHudStyleColorOpen(activeColor, 'defaultStyle', null, 'descriptionColor')}
          onToggle={() => onToggleColor(defaultStyleColorTarget('descriptionColor'))}
          onChange={(hex) => onChangeColor('descriptionColor', hex)}
          onInherit={() => onChangeColor('descriptionColor', null)}
        />
        <StyleColorRow
          target={defaultStyleColorTarget('valueColor')}
          label="数值颜色"
          contextLabel="统一"
          readout={styleColorReadout('valueColor', itemStyle.valueColor)}
          color={valueFallback}
          inherit={itemStyle.valueColor === null}
          inheritLabel="自动"
          open={isHudStyleColorOpen(activeColor, 'defaultStyle', null, 'valueColor')}
          onToggle={() => onToggleColor(defaultStyleColorTarget('valueColor'))}
          onChange={(hex) => onChangeColor('valueColor', hex)}
          onInherit={() => onChangeColor('valueColor', null)}
        />
      </div>

      <div className="kh-style-foot">
        <span>
          这些设置会应用到所有指标；字号还会跟随上方的整体字体倍率，单个指标可覆盖布局和颜色。
        </span>
        <button
          type="button"
          className="btn sm ghost"
          title="把统一指标样式恢复为内置值"
          onClick={onReset}
        >
          恢复默认样式
        </button>
      </div>
    </div>
  )
}

/**
 * The compact drawer for one settled item. The four layout fields and the two
 * colours are the only per-item overrides; legacy sizes/weights are ignored
 * rather than copied into the new unified style.
 */
function MetricStyleEditor({
  metric,
  metricLabel,
  itemStyle,
  baseStyle,
  override,
  activeColor,
  reservedWidth,
  valueReserveWidth,
  onToggleColor,
  onChange,
  onClearField,
  onReset
}: {
  metric: KevinHudMetric
  metricLabel: string
  itemStyle: HudSettingsItemStyle
  baseStyle: HudSettingsItemStyle
  override: HudMetricStyleOverride
  activeColor: HudColorTarget | null
  reservedWidth: number
  valueReserveWidth: number
  onToggleColor: (target: HudColorTarget) => void
  onChange: (patch: HudMetricStyleOverride) => void
  onClearField: (field: HudMetricStyleField) => void
  onReset: () => void
}): ReactElement {
  const metricInfo = HUD_METRIC_BY_ID.get(metric)
  const hasOverride = Object.keys(override).length > 0
  const layout = readHudItemLayout(itemStyle)
  const baseLayout = readHudItemLayout(baseStyle)
  const overriddenLayout = new Set(
    HUD_LAYOUT_FIELDS.filter((field) => hasHudItemStyleField(override, field))
  )

  return (
    <div className="kh-style-editor">
      <div className="kh-style-intro">
        <div>
          <span className={`kh-style-badge${hasOverride ? ' custom' : ''}`}>
            {hasOverride ? '已单独调整' : '跟随统一'}
          </span>
          {' '}
          {metric === 'appName'
            ? '说明固定为真实应用图标（没有图标时用现有回退），数值固定为实际应用名称；排列、字号和粗细跟随统一设置，这里可单独调整这一项的宽度、间隔、对齐和颜色。'
            : '说明和数值的字体、粗细与排列跟随统一设置；这里可单独调整这一项的宽度、间隔、对齐和颜色。'}
        </div>
      </div>
      <div className="kh-style-reserve">
        {`${metricInfo?.reserve ?? '按这一类信息最宽的样子留出空间'} · 单项约 ${reservedWidth} px${
          valueReserveWidth > 0 ? `，右侧数值约 ${valueReserveWidth} px` : ''
        }。宽度会自动留足，刷新时不会左右跳动。`}
      </div>

      <HudLayoutFields
        contextLabel={metricLabel}
        layout={layout}
        base={baseLayout}
        overridden={overriddenLayout}
        onPatch={onChange}
        onFollow={onClearField}
      />

      <StyleColorRow
        target={metricStyleColorTarget(metric, 'descriptionColor')}
        label="说明颜色"
        contextLabel={metricLabel}
        readout={
          override.descriptionColor
            ? `自定义 · ${formatHudColor(override.descriptionColor)}`
            : baseStyle.descriptionColor
              ? `跟随统一 · ${formatHudColor(baseStyle.descriptionColor)}`
              : '跟随统一 · 自动（浅白）'
        }
        color={
          override.descriptionColor ??
          baseStyle.descriptionColor ??
          HUD_REFERENCE_DESCRIPTION_COLOR
        }
        inherit={override.descriptionColor === undefined}
        inheritLabel="跟随统一"
        open={isHudStyleColorOpen(activeColor, 'metricStyle', metric, 'descriptionColor')}
        onToggle={() =>
          onToggleColor(metricStyleColorTarget(metric, 'descriptionColor'))
        }
        onChange={(hex) => onChange({ descriptionColor: hex })}
        onInherit={() => onClearField('descriptionColor')}
      />
      <StyleColorRow
        target={metricStyleColorTarget(metric, 'valueColor')}
        label="数值颜色"
        contextLabel={metricLabel}
        readout={
          override.valueColor
            ? `自定义 · ${formatHudColor(override.valueColor)}`
            : baseStyle.valueColor
              ? `跟随统一 · ${formatHudColor(baseStyle.valueColor)}`
              : '跟随统一 · 自动（白色）'
        }
        color={
          override.valueColor ??
          baseStyle.valueColor ??
          HUD_REFERENCE_VALUE_COLOR
        }
        inherit={override.valueColor === undefined}
        inheritLabel="跟随统一"
        open={isHudStyleColorOpen(activeColor, 'metricStyle', metric, 'valueColor')}
        onToggle={() => onToggleColor(metricStyleColorTarget(metric, 'valueColor'))}
        onChange={(hex) => onChange({ valueColor: hex })}
        onInherit={() => onClearField('valueColor')}
      />

      <div className="kh-style-foot">
        <span>只影响「{metricLabel}」；其他指标继续使用统一样式。</span>
        <button
          type="button"
          className="btn sm ghost"
          disabled={!hasOverride}
          title={hasOverride ? '移除这个指标的颜色和布局调整' : '这个指标当前全部跟随统一'}
          onClick={onReset}
        >
          清除此指标覆盖
        </button>
      </div>
    </div>
  )
}

function HotkeyRow({
  value,
  onCommit
}: {
  value: string | null
  onCommit: (hotkey: string | null) => void
}): ReactElement {
  const [text, setText] = useState(value ?? '')

  useEffect(() => setText(value ?? ''), [value])

  const commit = (): void => {
    const next = normalizeHudHotkey(text)
    setText(next ?? '')
    if (next !== value) onCommit(next)
  }

  return (
    <HudRow
      name="全局快捷键"
      desc="留空表示不注册；每个应用各自独立，不会影响其他应用"
      action={
        <div className="kh-hotkey">
          <input
            className="input"
            value={text}
            placeholder="例如：Ctrl+Shift+H（可留空）"
            spellCheck={false}
            aria-label="KEVIN HUD 全局快捷键"
            onChange={(event) => setText(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              } else if (event.key === 'Escape') {
                setText(value ?? '')
                event.currentTarget.blur()
              }
            }}
          />
          {text && (
            <button
              type="button"
              className="btn sm ghost"
              title="清除快捷键（留空即不注册）"
              onClick={() => {
                setText('')
                if (value !== null) onCommit(null)
              }}
            >
              清除
            </button>
          )}
        </div>
      }
    />
  )
}

/**
 * Live updates are throttled to one request per interval (same-frame edits and
 * slider movement merge into the latest draft). 24 ms stays inside the shared
 * 16–50 ms budget while keeping the preview responsive.
 */
export const HUD_LIVE_SYNC_INTERVAL_MS = 24

export type HudLiveDispatchDecision = 'send' | 'wait' | 'skip'

/**
 * Decide whether the latest draft needs another live IPC.
 *
 * - neither an open preview nor a validated live channel (`liveActive`): never
 *   open one implicitly;
 * - a request is in flight: wait so a newer value cannot overtake it;
 * - the applied signature already matches: skip the duplicate IPC.
 *
 * `liveActive` is true only when the caller owns the formal `onUpdateLive`
 * callback. The main process amends an already bound HUD/preview, so this path
 * must not depend on a preview being open.
 */
export function resolveHudLiveDispatch({
  previewActive,
  liveActive = false,
  inFlight,
  signature,
  appliedSignature
}: {
  previewActive: boolean
  liveActive?: boolean
  inFlight: boolean
  signature: string
  appliedSignature: string
}): HudLiveDispatchDecision {
  if (!previewActive && !liveActive) return 'skip'
  if (inFlight) return 'wait'
  if (signature === appliedSignature) return 'skip'
  return 'send'
}

export interface KevinHudSettingsProps {
  appId: string
  appName: string
  config: KevinHudConfig
  /** Persist one complete config. The editor serializes calls per component. */
  onSave: (appId: string, config: KevinHudConfig) => Promise<unknown>
  /** Open / refresh the live overlay preview. */
  onPreview: (appId: string, config: KevinHudConfig) => Promise<unknown>
  /** Close the live overlay preview. */
  onDismissPreview: () => Promise<unknown>
  /**
   * Refresh an already bound HUD or preview without reopening it. Optional so
   * existing callers/tests keep working; without it the editor falls back to
   * onPreview and only updates while a preview is open.
   */
  onUpdateLive?: (appId: string, config: KevinHudConfig) => Promise<unknown>
}

/**
 * Per-app KEVIN HUD editor inside 模块管理. It is deliberately NOT a home
 * module: there is no draggable card entry, only this independent switch and
 * expandable form.
 *
 * Saves are coalesced per app, then pushed through one serial queue with the
 * app id captured when the change was made. Leaving the page flushes the latest
 * draft, so switching apps cannot write one app's values into another.
 */
export default function KevinHudSettings({
  appId,
  appName,
  config,
  onSave,
  onPreview,
  onDismissPreview,
  onUpdateLive
}: KevinHudSettingsProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<HudSettingsConfig>(() => normalizeHudSettings(config))
  const [colorTarget, setColorTarget] = useState<HudColorTarget | null>(null)
  const [defaultStyleOpen, setDefaultStyleOpen] = useState(false)
  const [styleMetric, setStyleMetric] = useState<KevinHudMetric | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState('')
  const [previewOn, setPreviewOn] = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [copyOpen, setCopyOpen] = useState(false)
  /** `null` until a successful read; `[]` means every other app uses defaults. */
  const [copySources, setCopySources] = useState<HudCopySource[] | null>(null)
  const [copySourceId, setCopySourceId] = useState('')
  const [copyLoading, setCopyLoading] = useState(false)
  const [copyError, setCopyError] = useState('')
  const [copyNotice, setCopyNotice] = useState('')
  const previewRequestRef = useRef(0)
  const copyRequestRef = useRef(0)

  const appIdRef = useRef(appId)
  const draftRef = useRef(draft)
  const revisionRef = useRef(0)
  const dirtyRef = useRef(false)
  const mountedRef = useRef(true)
  const signedConfigRef = useRef('')
  /** Last config actually handed to a live surface, keyed by app id. */
  const appliedLiveRef = useRef(new Map<string, string>())
  const storedConfigKeyRef = useRef(JSON.stringify(normalizeHudSettings(config)))
  const previewOnRef = useRef(false)
  const previewOpeningRef = useRef(false)
  const liveEpochRef = useRef(0)
  const liveTimerRef = useRef<number | null>(null)
  const liveDirtyRef = useRef(false)
  const liveInFlightRef = useRef(false)
  const previewQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const flushLiveRef = useRef<() => Promise<void>>(async () => undefined)
  const scheduleLiveRef = useRef<(delayMs?: number) => void>(() => undefined)
  const onSaveRef = useRef(onSave)
  const onPreviewRef = useRef(onPreview)
  const onDismissPreviewRef = useRef(onDismissPreview)
  const onUpdateLiveRef = useRef(onUpdateLive)
  onSaveRef.current = onSave
  onPreviewRef.current = onPreview
  onDismissPreviewRef.current = onDismissPreview
  onUpdateLiveRef.current = onUpdateLive
  const headerMotion = useHudHeaderMotion()

  const [textFallback, setTextFallback] = useState(
    config.textColor === 'auto' ? '#FFFFFF' : config.textColor
  )
  const [iconFallback, setIconFallback] = useState(config.iconColor ?? '#FFFFFF')

  // One debounce slot per app, plus a single serial IPC queue.
  const pendingTimers = useRef(
    new Map<string, { timer: number; config: HudSettingsConfig; revision: number }>()
  )
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve())
  const pendingCountRef = useRef(0)

  const enqueueSave = useCallback(
    (targetAppId: string, next: HudSettingsConfig, revision: number, silent = false): void => {
      if (!silent && targetAppId === appIdRef.current) {
        pendingCountRef.current += 1
        setSaveState('saving')
        setSaveError('')
      }
      const previous = saveQueue.current.catch(() => undefined)
      const task = previous.then(() =>
        onSaveRef.current(targetAppId, normalizeHudSettings(next))
      )
      saveQueue.current = task.then(
        () => undefined,
        () => undefined
      )
      task.then(
        () => {
          if (silent) return
          if (!mountedRef.current || targetAppId !== appIdRef.current) return
          pendingCountRef.current = Math.max(0, pendingCountRef.current - 1)
          if (revision === revisionRef.current && pendingCountRef.current === 0) {
            dirtyRef.current = false
            setSaveState('saved')
            setSaveError('')
          }
        },
        (error: unknown) => {
          if (silent) return
          if (!mountedRef.current || targetAppId !== appIdRef.current) return
          pendingCountRef.current = Math.max(0, pendingCountRef.current - 1)
          setSaveState('error')
          setSaveError(errorText(error, '保存 KEVIN HUD 设置失败'))
        }
      )
    },
    []
  )

  const flushSave = useCallback(
    (targetAppId: string, next: HudSettingsConfig, revision: number, silent = false): void => {
      const pending = pendingTimers.current.get(targetAppId)
      if (pending) {
        window.clearTimeout(pending.timer)
        pendingTimers.current.delete(targetAppId)
      }
      enqueueSave(targetAppId, next, revision, silent)
    },
    [enqueueSave]
  )

  const scheduleSave = useCallback(
    (targetAppId: string, next: HudSettingsConfig, revision: number): void => {
      const existing = pendingTimers.current.get(targetAppId)
      if (existing) window.clearTimeout(existing.timer)
      const timer = window.setTimeout(() => {
        const pending = pendingTimers.current.get(targetAppId)
        if (!pending || pending.timer !== timer) return
        pendingTimers.current.delete(targetAppId)
        enqueueSave(targetAppId, pending.config, pending.revision)
      }, 260)
      pendingTimers.current.set(targetAppId, { timer, config: next, revision })
    },
    [enqueueSave]
  )

  /**
   * One serial queue for preview open / live refresh / dismiss. It keeps a
   * slower older request from landing after a newer preview state and makes an
   * explicit preview open wait for an already-running live update.
   */
  const enqueuePreviewCall = useCallback(
    <T,>(task: () => Promise<T>): Promise<T> => {
      const next = previewQueueRef.current.catch(() => undefined).then(task)
      previewQueueRef.current = next.catch(() => undefined)
      return next
    },
    []
  )

  const dismissOverlay = useCallback((): void => {
    try {
      void enqueuePreviewCall(async () => {
        await onDismissPreviewRef.current()
      }).catch(() => undefined)
    } catch {
      // The preview bridge may be unavailable while another batch is wiring it;
      // failing to close must never break the editor.
    }
  }, [enqueuePreviewCall])

  /** Drop a queued live refresh and ignore any response still in flight. */
  const cancelLiveSync = useCallback((): void => {
    if (liveTimerRef.current !== null) {
      window.clearTimeout(liveTimerRef.current)
      liveTimerRef.current = null
    }
    liveDirtyRef.current = false
    liveEpochRef.current += 1
  }, [])

  /**
   * Throttle, not debounce: a busy slider still reaches the overlay at most once
   * per interval. The flush reads `draftRef` at fire time, so every later edit
   * is merged before the request is built.
   */
  const scheduleLiveUpdate = useCallback(
    (delayMs = HUD_LIVE_SYNC_INTERVAL_MS): void => {
      if (!mountedRef.current) return
      // A formal live callback can amend an already running HUD; only the
      // legacy fallback needs an open preview.
      if (!previewOnRef.current && !onUpdateLiveRef.current) return
      liveDirtyRef.current = true
      // The explicit open already carries the latest draft; do not duplicate
      // it with a live refresh while that request is still pending.
      if (previewOpeningRef.current) return
      if (liveInFlightRef.current || liveTimerRef.current !== null) return
      liveTimerRef.current = window.setTimeout(() => {
        liveTimerRef.current = null
        void flushLiveRef.current()
      }, delayMs)
    },
    []
  )

  const flushLiveUpdate = useCallback(async (): Promise<void> => {
    const hasLiveCallback = !!onUpdateLiveRef.current
    if (!mountedRef.current || (!previewOnRef.current && !hasLiveCallback)) {
      liveDirtyRef.current = false
      return
    }
    if (previewOpeningRef.current) {
      liveDirtyRef.current = true
      return
    }
    const targetAppId = appIdRef.current
    const config = normalizeHudSettings(draftRef.current)
    const signature = JSON.stringify(config)
    const decision = resolveHudLiveDispatch({
      previewActive: previewOnRef.current,
      liveActive: hasLiveCallback,
      inFlight: liveInFlightRef.current,
      signature,
      appliedSignature: appliedLiveRef.current.get(targetAppId) ?? ''
    })
    if (decision === 'skip') {
      liveDirtyRef.current = false
      return
    }
    if (decision === 'wait') {
      liveDirtyRef.current = true
      return
    }

    const epoch = liveEpochRef.current
    liveInFlightRef.current = true
    liveDirtyRef.current = false
    // The legacy callback may only refresh an open preview; the formal live
    // callback is safe for an already bound real HUD and needs no preview.
    const applyLive = onUpdateLiveRef.current ?? onPreviewRef.current
    try {
      await enqueuePreviewCall(async () => applyLive(targetAppId, config))
      if (
        !mountedRef.current ||
        liveEpochRef.current !== epoch ||
        appIdRef.current !== targetAppId
      ) {
        return
      }
      appliedLiveRef.current.set(targetAppId, signature)
      if (previewOnRef.current) setPreviewError('')
      // A change made while this request was in flight still needs one more
      // call; the finally block starts that latest-only follow-up.
      if (JSON.stringify(normalizeHudSettings(draftRef.current)) !== signature) {
        liveDirtyRef.current = true
      }
    } catch (error) {
      if (
        !mountedRef.current ||
        liveEpochRef.current !== epoch ||
        appIdRef.current !== targetAppId
      ) {
        return
      }
      // Closing/clearing preview ownership is only correct while a preview is
      // actually open. A real HUD update failure must let the next edit retry
      // instead of tearing preview state down or disabling the live path.
      if (!previewOnRef.current) return
      previewOnRef.current = false
      signedConfigRef.current = ''
      setPreviewOn(false)
      setPreviewError(
        `无法继续同步预览：${errorText(error, '预览已不可用')}。已停止自动同步，请重新打开预览。`
      )
      dismissOverlay()
    } finally {
      liveInFlightRef.current = false
      if (
        mountedRef.current &&
        (previewOnRef.current || onUpdateLiveRef.current) &&
        liveDirtyRef.current
      ) {
        scheduleLiveRef.current(0)
      }
    }
  }, [dismissOverlay, enqueuePreviewCall])

  flushLiveRef.current = flushLiveUpdate
  scheduleLiveRef.current = scheduleLiveUpdate

  // Leaving the page (or switching app) must not lose the last slider movement.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      // Capture the latest draft before the teardown below drops queued live
      // work. One merged send keeps a same-frame edit visible to a real HUD.
      const pendingLive = liveDirtyRef.current || liveTimerRef.current !== null
      const targetAppId = appIdRef.current
      const liveConfig = normalizeHudSettings(draftRef.current)
      const liveSignature = JSON.stringify(liveConfig)
      const liveApply =
        onUpdateLiveRef.current ??
        (previewOnRef.current ? onPreviewRef.current : null)
      mountedRef.current = false
      previewRequestRef.current += 1
      copyRequestRef.current += 1
      cancelLiveSync()
      previewOpeningRef.current = false
      if (
        pendingLive &&
        liveApply &&
        appliedLiveRef.current.get(targetAppId) !== liveSignature
      ) {
        appliedLiveRef.current.set(targetAppId, liveSignature)
        void enqueuePreviewCall(async () => liveApply(targetAppId, liveConfig)).catch(
          () => undefined
        )
      }
      previewOnRef.current = false
      for (const [target, pending] of pendingTimers.current) {
        window.clearTimeout(pending.timer)
        enqueueSave(target, pending.config, pending.revision, true)
      }
      pendingTimers.current.clear()
      if (signedConfigRef.current) {
        signedConfigRef.current = ''
        dismissOverlay()
      }
    }
  }, [cancelLiveSync, dismissOverlay, enqueuePreviewCall, enqueueSave])

  // App switch (defensive: ModuleManagerView also keys this component by app id).
  useEffect(() => {
    if (appIdRef.current === appId) return
    appIdRef.current = appId
    revisionRef.current = 0
    pendingCountRef.current = 0
    dirtyRef.current = false
    storedConfigKeyRef.current = JSON.stringify(normalizeHudSettings(config))
    const next = normalizeHudSettings(config)
    draftRef.current = next
    setDraft(next)
    setSaveState('idle')
    setSaveError('')
    setPreviewError('')
    setStyleMetric(null)
    setDefaultStyleOpen(false)
    setColorTarget(null)
    setCopyOpen(false)
    setCopySources(null)
    setCopySourceId('')
    setCopyLoading(false)
    setCopyError('')
    setCopyNotice('')
    copyRequestRef.current += 1
    previewRequestRef.current += 1
    cancelLiveSync()
    previewOnRef.current = false
    previewOpeningRef.current = false
    setPreviewOn(false)
    if (signedConfigRef.current) {
      signedConfigRef.current = ''
      dismissOverlay()
    }
  }, [appId, config, cancelLiveSync, dismissOverlay])

  // Adopt an external update only when the user has no unsaved edit in flight.
  useEffect(() => {
    const normalized = normalizeHudSettings(config)
    const key = JSON.stringify(normalized)
    if (key === storedConfigKeyRef.current) return
    storedConfigKeyRef.current = key
    if (dirtyRef.current || pendingCountRef.current > 0) return
    draftRef.current = normalized
    setDraft(normalized)
  }, [config])

  const updateConfig = useCallback(
    (patch: Partial<HudSettingsConfig>, immediate = false): void => {
      const next = normalizeHudSettings({ ...draftRef.current, ...patch })
      const revision = ++revisionRef.current
      dirtyRef.current = true
      draftRef.current = next
      setDraft(next)
      if (immediate) flushSave(appIdRef.current, next, revision)
      else scheduleSave(appIdRef.current, next, revision)
      scheduleLiveUpdate()
    },
    [flushSave, scheduleLiveUpdate, scheduleSave]
  )

  const dismissPreview = useCallback((): void => {
    previewRequestRef.current += 1
    cancelLiveSync()
    previewOnRef.current = false
    previewOpeningRef.current = false
    signedConfigRef.current = ''
    setPreviewOn(false)
    setPreviewError('')
    dismissOverlay()
  }, [cancelLiveSync, dismissOverlay])

  const endPreview = useCallback((): void => {
    if (!previewOn && !signedConfigRef.current) return
    dismissPreview()
  }, [dismissPreview, previewOn])

  const startPreview = useCallback(async (): Promise<void> => {
    if (previewBusy) return
    const targetAppId = appIdRef.current
    const request = ++previewRequestRef.current
    const previewConfig = normalizeHudSettings(draftRef.current)
    const previewSignature = JSON.stringify(previewConfig)
    // An explicit open is authoritative: drop queued live work, and let the
    // shared queue finish any already-running update before this open.
    cancelLiveSync()
    previewOnRef.current = false
    previewOpeningRef.current = true
    setPreviewOn(false)
    setPreviewBusy(true)
    setPreviewError('')
    try {
      await enqueuePreviewCall(async () => onPreviewRef.current(targetAppId, previewConfig))
      if (!mountedRef.current) {
        dismissOverlay()
        return
      }
      if (request !== previewRequestRef.current || appIdRef.current !== targetAppId) {
        dismissOverlay()
        return
      }
      signedConfigRef.current = previewSignature
      previewOnRef.current = true
      setPreviewOn(true)
      // Edits made while the open request was pending are newer than the
      // snapshot the overlay received; send one live update for the latest.
      if (JSON.stringify(normalizeHudSettings(draftRef.current)) !== previewSignature) {
        scheduleLiveUpdate(0)
      }
    } catch (error) {
      if (mountedRef.current && request === previewRequestRef.current) {
        previewOnRef.current = false
        setPreviewOn(false)
        setPreviewError(
          errorText(error, '无法打开 HUD 预览，请确认主窗口仍在运行')
        )
      }
    } finally {
      // A newer open owns the flag; an app switch / dismiss already reset it.
      if (request === previewRequestRef.current) previewOpeningRef.current = false
      if (mountedRef.current) {
        setPreviewBusy(false)
        // A change queued while the open was pending still belongs on the
        // live surface, even when the explicit open itself failed.
        if (liveDirtyRef.current) scheduleLiveUpdate(0)
      }
    }
  }, [
    cancelLiveSync,
    dismissOverlay,
    enqueuePreviewCall,
    previewBusy,
    scheduleLiveUpdate
  ])

  // The preview control lives inside the form, so closing the form must close
  // the on-screen overlay as well — otherwise it would be left without a way
  // to dismiss it from this page.
  useEffect(() => {
    if (open) return
    setColorTarget(null)
    setDefaultStyleOpen(false)
    setStyleMetric(null)
    setCopyOpen(false)
    if (previewOn || signedConfigRef.current) dismissPreview()
  }, [dismissPreview, open, previewOn])

  // A removed metric cannot keep a stale style drawer open in the list.
  useEffect(() => {
    if (styleMetric === null) return
    if (!draft.metrics.includes(styleMetric)) {
      setStyleMetric(null)
    }
  }, [draft.metrics, styleMetric])

  const backgroundIsApp = draft.backgroundMode === 'app'
  const backgroundIsGradient = draft.backgroundMode === 'gradient'
  const materialEditable = draft.backgroundMode === 'custom'
  const materialDesc = backgroundIsApp
    ? '应用外观会直接使用这个应用现在的玻璃效果'
    : backgroundIsGradient
      ? '渐变色背景不叠加材质；想用玻璃效果请选「自定义」'
      : draft.backgroundMode === 'solid'
        ? '纯色背景不叠加材质；想用玻璃效果请选「自定义」'
        : '给自定义背景叠一层玻璃质感'
  const textIsAuto = draft.textColor === 'auto'
  const iconIsOriginal = draft.iconColor === null
  const radiusMax = Math.max(0, Math.floor(draft.height / 2))

  // A panel whose row became disabled / automatic is hidden in the same render;
  // the effect below clears the stored field so switching back cannot reopen it.
  const activeColorField =
    colorTarget?.kind === 'config'
      ? resolveActiveColorField(colorTarget.field, {
          backgroundIsApp,
          backgroundIsGradient,
          textIsAuto,
          iconIsOriginal
        })
      : null

  // Close an editor that became inapplicable through another control, or whose
  // owning style drawer is no longer open. The explicit check avoids mounting a
  // hidden ColorPicker in a collapsed drawer.
  useEffect(() => {
    if (colorTarget === null) return
    if (colorTarget.kind === 'config') {
      if (activeColorField === null) setColorTarget(null)
      return
    }
    if (colorTarget.kind === 'defaultStyle' && !defaultStyleOpen) {
      setColorTarget(null)
      return
    }
    if (
      colorTarget.kind === 'metricStyle' &&
      (styleMetric !== colorTarget.metric || !draft.metrics.includes(colorTarget.metric))
    ) {
      setColorTarget(null)
    }
  }, [activeColorField, colorTarget, defaultStyleOpen, draft.metrics, styleMetric])

  const widthBounds = resolveKevinHudWidthBounds(draft)
  const maxWidth = widthBounds.maxWidth
  const itemGap = resolveKevinHudItemGap(draft)
  const contentPadding = resolveKevinHudContentPadding(draft)
  // Sizing must follow the new contract: only the allowed per-item overrides are
  // applied, while legacy beta layout fields are ignored.
  const sizingConfig = {
    ...draft,
    itemStyles: sanitizeHudItemStyles(draft.itemStyles)
  }
  const minContentHeight = measureKevinHudMinContentHeight(sizingConfig)
  const heightBelowMinimum = minContentHeight > draft.height
  const defaultItemStyle: HudSettingsItemStyle = {
    ...(normalizeKevinHudItemStyle(draft.itemStyle) as HudSettingsItemStyle),
    descriptionColor:
      (draft.itemStyle as HudSettingsItemStyle).descriptionColor ?? null,
    valueColor: (draft.itemStyle as HudSettingsItemStyle).valueColor ?? null
  }

  const setOverflowMode = (mode: HudOverflowMode): void => {
    if (mode === 'grow') {
      const rememberedMax = draft.maxWidth > draft.width ? draft.maxWidth : maxWidth
      const nextMax =
        rememberedMax > draft.width
          ? Math.min(HUD_WIDTH_MAX, rememberedMax)
          : Math.min(HUD_WIDTH_MAX, Math.max(960, draft.width + 320))
      updateConfig({ autoWidth: true, maxWidth: nextMax }, true)
      return
    }
    updateConfig({ autoWidth: false, maxWidth: draft.width }, true)
  }

  const setWidthValue = (value: number): void => {
    const width = clampHudNumber(value, HUD_WIDTH_MIN, HUD_WIDTH_MAX, draft.width)
    updateConfig({
      width,
      maxWidth: draft.autoWidth ? Math.max(width, maxWidth) : width
    })
  }

  const setMaxWidthValue = (value: number): void => {
    const nextMaxWidth = clampHudNumber(value, draft.width, HUD_WIDTH_MAX, maxWidth)
    updateConfig({
      maxWidth: nextMaxWidth,
      autoWidth: nextMaxWidth > draft.width
    })
  }

  const raiseHeightToMinimum = (): void => {
    updateConfig(
      {
        height: minContentHeight,
        radius: Math.min(draft.radius, Math.floor(minContentHeight / 2))
      },
      true
    )
  }

  const toggleColorTarget = (target: HudColorTarget): void => {
    setColorTarget((current) => (sameHudColorTarget(current, target) ? null : target))
  }

  const toggleDefaultStyle = (): void => {
    setColorTarget(null)
    setStyleMetric(null)
    setDefaultStyleOpen((value) => !value)
  }

  const toggleMetricStyle = (metric: KevinHudMetric): void => {
    setColorTarget(null)
    setDefaultStyleOpen(false)
    setStyleMetric((current) => (current === metric ? null : metric))
  }

  const setDefaultItemStyle = (patch: HudItemStylePatch): void => {
    updateConfig({
      itemStyle: {
        ...defaultItemStyle,
        ...patch
      } as KevinHudItemStyle
    })
  }

  const setDefaultItemColor = (
    field: HudStyleColorField,
    value: string | null
  ): void => {
    updateConfig({
      itemStyle: {
        ...defaultItemStyle,
        [field]: value
      } as KevinHudItemStyle
    })
  }

  const setMetricItemStyle = (
    metric: KevinHudMetric,
    patch: HudMetricStyleOverride
  ): void => {
    const currentStyles = sanitizeHudItemStyles(draftRef.current.itemStyles)
    const current = getHudMetricStyleOverride(currentStyles, metric)
    const nextOverride = sanitizeHudMetricStyleOverride({ ...current, ...patch })
    const nextStyles = { ...currentStyles }
    if (Object.keys(nextOverride).length > 0) {
      nextStyles[metric] = nextOverride
    } else {
      delete nextStyles[metric]
    }
    updateConfig({ itemStyles: nextStyles })
  }

  const clearMetricStyleField = (
    metric: KevinHudMetric,
    field: HudMetricStyleField
  ): void => {
    updateConfig(
      {
        itemStyles: clearHudMetricStyleField(
          draftRef.current.itemStyles,
          metric,
          field
        )
      },
      true
    )
  }

  const resetDefaultItemStyle = (): void => {
    const base = normalizeKevinHudItemStyle(DEFAULT_HUD_ITEM_STYLE) as HudSettingsItemStyle
    updateConfig(
      {
        itemStyle: {
          ...base,
          descriptionColor: null,
          valueColor: null
        } as KevinHudItemStyle
      },
      true
    )
  }

  const resetMetricItemStyle = (metric: KevinHudMetric): void => {
    updateConfig(
      { itemStyles: clearHudMetricItemStyle(draftRef.current.itemStyles, metric) },
      true
    )
  }

  const resetDefaults = (): void => {
    const next = resetHudConfig()
    setColorTarget(null)
    setDefaultStyleOpen(false)
    setStyleMetric(null)
    setCopyOpen(false)
    setCopyNotice('')
    setTextFallback('#FFFFFF')
    setIconFallback('#FFFFFF')
    updateConfig(next, true)
  }

  const loadCopySources = useCallback(async (): Promise<void> => {
    const targetAppId = appIdRef.current
    const request = ++copyRequestRef.current
    setCopyLoading(true)
    setCopyError('')
    setCopyNotice('')
    try {
      const apps = await window.api.listApps()
      if (
        !mountedRef.current ||
        request !== copyRequestRef.current ||
        appIdRef.current !== targetAppId
      ) {
        return
      }
      const sources = buildHudCopySources(apps, targetAppId)
      setCopySources(sources)
      setCopySourceId(sources.length > 0 ? sources[0].id : '')
    } catch (error) {
      if (
        !mountedRef.current ||
        request !== copyRequestRef.current ||
        appIdRef.current !== targetAppId
      ) {
        return
      }
      setCopySources(null)
      setCopySourceId('')
      setCopyError(errorText(error, '读取应用列表失败'))
    } finally {
      if (
        mountedRef.current &&
        request === copyRequestRef.current &&
        appIdRef.current === targetAppId
      ) {
        setCopyLoading(false)
      }
    }
  }, [])

  const toggleCopyPanel = (): void => {
    setColorTarget(null)
    if (copyOpen) {
      setCopyOpen(false)
      return
    }
    setCopyOpen(true)
    if (copySources === null && !copyLoading) void loadCopySources()
  }

  const applyCopySource = (): void => {
    if (copyLoading) return
    const source = copySources?.find((candidate) => candidate.id === copySourceId)
    if (!source) return
    const targetAppId = appIdRef.current
    // The plan is normalized and independent from the source app, and its
    // newer revision + immediate save clears any pending debounce for this app.
    const plan = planHudCopyApply(source.config, revisionRef.current)
    revisionRef.current = plan.revision
    dirtyRef.current = true
    draftRef.current = plan.config
    setDraft(plan.config)
    setTextFallback(
      plan.config.textColor === 'auto' ? '#FFFFFF' : plan.config.textColor
    )
    setIconFallback(plan.config.iconColor ?? '#FFFFFF')
    setCopyError('')
    setCopyNotice(`已应用「${source.name}」的设置；「${source.name}」本身没有改动。`)
    flushSave(targetAppId, plan.config, plan.revision)
    // Copy/reset are ordinary draft commits: an open preview follows the same
    // throttled latest-value path instead of a second, competing IPC.
    scheduleLiveUpdate()
  }

  const selectedMetrics = useMemo(
    () =>
      draft.metrics
        .map((id) => HUD_METRIC_BY_ID.get(id))
        .filter((metric): metric is HudMetricInfo => !!metric),
    [draft.metrics]
  )
  const availableMetrics = HUD_METRIC_INFO.filter((metric) => !draft.metrics.includes(metric.id))
  const sampleOptions = useMemo(() => {
    const values = [...SAMPLE_SECONDS]
    if (!values.includes(draft.sampleSeconds)) values.push(draft.sampleSeconds)
    values.sort((a, b) => a - b)
    return values.map((seconds) => ({
      value: String(seconds),
      label:
        seconds === 0.5 || seconds === 1 || seconds === 2
          ? `${formatNumber(seconds, 1)} 秒（常用）`
          : `${formatNumber(seconds, 1)} 秒`
    }))
  }, [draft.sampleSeconds])

  const setFieldColor = (field: HudColorField, hex: string): void => {
    switch (field) {
      case 'background':
        updateConfig({ backgroundColor: hex })
        break
      case 'border':
        updateConfig({ borderColor: hex })
        break
      case 'text':
        setTextFallback(hex)
        updateConfig({ textColor: hex })
        break
      case 'icon':
        setIconFallback(hex)
        updateConfig({ iconColor: hex })
        break
    }
  }

  const statusText = previewError
    ? `预览失败：${previewError}`
    : saveError
      ? `保存失败：${saveError}`
      : previewBusy
        ? '正在打开预览…'
        : previewOn && saveState === 'saving'
          ? '预览中 · 保存中…'
          : previewOn
            ? '预览中 · 修改会实时同步'
            : saveState === 'saving'
              ? '保存中…'
              : saveState === 'saved'
                ? '已保存'
                : saveState === 'error'
                  ? '保存失败'
                  : '修改会自动保存'
  const statusError = !!previewError || !!saveError

  return (
    <div className="settings kh-card">
      <Collapse
        open={open}
        header={
          <div className="kh-head" data-kh-anim={headerMotion ? 'on' : 'off'}>
            <div className="kh-head-main">
              <span className="kh-mark" aria-hidden="true">
                <span className="kh-mark-text">HUD</span>
                <span className="kh-mark-scan" />
              </span>
              <div className="kh-head-copy">
                <div className="kh-head-title">
                  <span className="kh-wordmark">KEVIN HUD</span>
                  <span className="kh-fresh">全新功能</span>
                </div>
                <div className="kh-head-sub">
                  {appName} · 在游戏里随时查看帧率、内存和运行状态
                </div>
              </div>
            </div>
            <div className="kh-head-right">
              <div className="module-controls kh-head-actions">
                <Switch
                  checked={draft.enabled}
                  label="启用"
                  title="为该应用启用 KEVIN HUD"
                  onChange={(enabled) => updateConfig({ enabled }, true)}
                />
                <button
                  type="button"
                  className={`btn sm ghost module-caret${open ? ' open' : ''}`}
                  title={open ? '收起 KEVIN HUD 设置' : '展开 KEVIN HUD 设置'}
                  aria-expanded={open}
                  aria-controls="kevin-hud-settings-form"
                  onClick={() => setOpen((value) => !value)}
                >
                  <Icon name="chevronDown" size={16} />
                </button>
              </div>
            </div>
          </div>
        }
      >
        <div className="kh-form" id="kevin-hud-settings-form" role="group" aria-label="KEVIN HUD 设置">
          <div className="kh-notice" role="note">
            <span>游戏打开后，HUD 会浮在游戏画面上，显示你勾选的信息。</span>
            <span>如果看不到，请把游戏切换为窗口化或无边框；独占全屏能否显示由游戏决定。读不到的项目会显示「--」，也可以按快捷键隐藏或显示。</span>
          </div>
          <KevinHudCopySettings
            appName={appName}
            state={{
              open: copyOpen,
              loading: copyLoading,
              error: copyError,
              sources: copySources,
              selectedId: copySourceId,
              notice: copyNotice
            }}
            actions={{
              onToggle: toggleCopyPanel,
              onSelect: (value) => {
                setCopySourceId(value)
                setCopyNotice('')
              },
              onReload: () => void loadCopySources(),
              onApply: applyCopySource
            }}
          />
          <div className="settings-group-title">显示与位置</div>
          <ToggleRow
            name="常驻显示"
            desc="进入游戏后一直显示，不会自动收起"
            checked={draft.alwaysVisible}
            label="常驻"
            onChange={(alwaysVisible) => updateConfig({ alwaysVisible }, true)}
          />
          <RangeRow
            name="短时显示时长"
            desc="没有开启常驻时，HUD 停留多久后自动消失"
            value={draft.displaySeconds}
            min={3}
            max={10}
            step={1}
            display={(value) => `${formatNumber(value)} 秒`}
            onChange={(displaySeconds) => updateConfig({ displaySeconds })}
          />
          <HudRow
            name="刷新间隔"
            desc="信息更新的快慢；1 秒适合大多数游戏"
            action={
              <Select
                value={String(draft.sampleSeconds)}
                options={sampleOptions}
                onChange={(value) => updateConfig({ sampleSeconds: Number(value) })}
              />
            }
          />
          <HudRow
            name="进出场方向"
            desc="HUD 出现和收起时从哪个方向滑入"
            action={
              <Select
                value={draft.direction}
                options={DIRECTION_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label
                }))}
                onChange={(value) => updateConfig({ direction: value as KevinHudDirection })}
              />
            }
          />
          <HudRow
            name="位置"
            desc={
              draft.positionMode === 'preset'
                ? '屏幕顶部居中，默认留出一小段距离'
                : '用下方的锚点和百分比手动摆放；切换回预设不会丢失这些数值'
            }
            action={
              <Segmented
                value={draft.positionMode}
                options={POSITION_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label
                }))}
                onChange={(value) =>
                  updateConfig({ positionMode: value as KevinHudPositionMode }, true)
                }
              />
            }
          />
          {draft.positionMode === 'custom' && (
            <>
              <HudRow
                name="屏幕锚点"
                desc="水平位置的参照点；位置越界时会自动回到屏幕内"
                action={
                  <Segmented
                    value={draft.anchor}
                    options={ANCHOR_OPTIONS.map((option) => ({
                      value: option.value,
                      label: option.label
                    }))}
                    onChange={(value) => updateConfig({ anchor: value as KevinHudAnchor })}
                  />
                }
              />
              <RangeRow
                name="水平位置"
                desc="屏幕宽度的百分比；和上面的锚点一起决定位置"
                value={draft.x}
                min={0}
                max={100}
                step={1}
                display={(value) => `${formatNumber(value)} %`}
                onChange={(x) => updateConfig({ x })}
              />
              <RangeRow
                name="垂直位置"
                desc="屏幕高度的百分比；默认靠近屏幕顶部"
                value={draft.y}
                min={0}
                max={100}
                step={1}
                display={(value) => `${formatNumber(value)} %`}
                onChange={(y) => updateConfig({ y })}
              />
            </>
          )}
          <HudRow
            name="显示器"
            desc="主显示器固定在主屏；游戏所在屏会跟着游戏窗口走"
            action={
              <Select
                value={draft.monitor}
                options={MONITOR_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label
                }))}
                onChange={(value) => updateConfig({ monitor: value as KevinHudMonitor })}
              />
            }
          />
          <HudRow
            name="内容放不下时"
            desc={
              draft.autoWidth
                ? '信息保持一行；放不下时自动加宽，到了最大宽度再在 HUD 里横向滚动'
                : '信息保持一行；宽度固定，放不下时在 HUD 里横向滚动'
            }
            action={
              <Segmented
                value={draft.autoWidth ? 'grow' : 'scroll'}
                options={OVERFLOW_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label
                }))}
                title="内容放不下时的处理方式"
                onChange={(value) => setOverflowMode(value as HudOverflowMode)}
              />
            }
          />
          <HudRow
            name="尺寸"
            desc={
              draft.autoWidth
                ? '宽度是最小宽度，信息多了会自动加宽；高度同时用于开场标题和常驻信息。到最大宽度后改为横向滚动'
                : '宽度固定；信息多了在 HUD 里横向滚动。高度同时用于开场标题和常驻信息'
            }
            action={
              <div className="kh-pair">
                <NumericField
                  label={draft.autoWidth ? '最小宽度' : '宽'}
                  unit="px"
                  value={draft.width}
                  min={HUD_WIDTH_MIN}
                  max={HUD_WIDTH_MAX}
                  step={2}
                  onChange={setWidthValue}
                />
                <NumericField
                  label="最大宽度"
                  unit="px"
                  value={maxWidth}
                  min={draft.width}
                  max={HUD_WIDTH_MAX}
                  step={2}
                  disabled={!draft.autoWidth}
                  onChange={setMaxWidthValue}
                />
                <NumericField
                  label="高度"
                  unit="px"
                  value={draft.height}
                  min={HUD_HEIGHT_MIN}
                  max={HUD_HEIGHT_MAX}
                  step={1}
                  onChange={(height) =>
                    updateConfig({
                      height,
                      radius: Math.min(draft.radius, Math.floor(height / 2))
                    })
                  }
                />
              </div>
            }
          />
          <div className={`kh-size-note${heightBelowMinimum ? ' warn' : ''}`}>
            <span>
              高度是设置的下限（{HUD_HEIGHT_MIN}–{HUD_HEIGHT_MAX} px），当前排列至少需要{' '}
              {minContentHeight} px。字体或排列需要更多空间时，HUD 会自动增高，不会裁掉数字。
              {heightBelowMinimum ? ' 当前内容需要的高度比已保存值更高。' : ''}
            </span>
            {heightBelowMinimum && (
              <button type="button" className="btn sm ghost" onClick={raiseHeightToMinimum}>
                把保存高度改为 {minContentHeight} px
              </button>
            )}
          </div>
          <RangeRow
            name="指标最小间距"
            desc="相邻信息之间至少留出的空隙；空间不足时在 HUD 里滚动"
            value={itemGap}
            min={HUD_ITEM_GAP_RANGE[0]}
            max={HUD_ITEM_GAP_RANGE[1]}
            step={1}
            display={(value) => `${formatNumber(value)} px`}
            onChange={(itemGap) => updateConfig({ itemGap })}
          />
          <RangeRow
            name="内容内边距"
            desc="信息和 HUD 边缘之间的留白"
            value={contentPadding.horizontal}
            min={HUD_CONTENT_PADDING_RANGE[0]}
            max={HUD_CONTENT_PADDING_RANGE[1]}
            step={1}
            display={(value) => `${formatNumber(value)} px`}
            onChange={(nextPadding) => updateConfig({ contentPadding: nextPadding })}
          />

          <div className="settings-group-title">动效</div>
          <RangeRow
            name="回弹幅度"
            desc="进场时的过冲 / 回弹强度"
            value={draft.bounce}
            min={0}
            max={0.5}
            step={0.005}
            display={(value) => value.toFixed(3)}
            onChange={(bounce) => updateConfig({ bounce })}
          />
          <RangeRow
            name="波纹强度"
            desc="公告与状态变化时的波纹反馈"
            value={draft.ripple}
            min={0}
            max={2}
            step={0.01}
            display={(value) => value.toFixed(2)}
            onChange={(ripple) => updateConfig({ ripple })}
          />

          <div className="settings-group-title">外观</div>
          <HudRow
            name="背景模式"
            desc={LABELS[draft.backgroundMode].desc}
            action={
              <Segmented
                value={draft.backgroundMode}
                options={BACKGROUND_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label
                }))}
                onChange={(value) => {
                  if (value === 'app' || value === 'gradient') {
                    setColorTarget((current) =>
                      current?.kind === 'config' && current.field === 'background'
                        ? null
                        : current
                    )
                  }
                  updateConfig({ backgroundMode: value as KevinHudBackgroundMode })
                }}
              />
            }
          />
          <HudRow
            name="材质"
            desc={materialDesc}
            action={
              <Select
                value={draft.material}
                disabled={!materialEditable}
                options={MATERIAL_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label
                }))}
                onChange={(value) => updateConfig({ material: value as GlassMaterial })}
              />
            }
          />
          <RangeRow
            name="圆角"
            desc={`0 为直角；当前高度的一半（${radiusMax} px）为全胶囊`}
            value={draft.radius}
            min={0}
            max={radiusMax}
            step={1}
            display={(value) => `${formatNumber(value)} px`}
            onChange={(radius) => updateConfig({ radius })}
          />
          <RangeRow
            name="边框宽度"
            desc="0 表示无描边"
            value={draft.borderWidth}
            min={0}
            max={6}
            step={1}
            display={(value) => `${formatNumber(value)} px`}
            onChange={(borderWidth) => updateConfig({ borderWidth })}
          />
          {/* Each colour trigger is its own collapse header so its field row
              stays visible above the picker; only one field is active. */}
          <ColorEditorPanel
            id={COLOR_EDITOR_IDS.border}
            open={activeColorField === 'border'}
            label="边框颜色"
            color={draft.borderColor}
            onChange={(hex) => setFieldColor('border', hex)}
            header={
              <HudRow
                name="边框颜色"
                desc="边框宽度大于 0 时生效"
                action={
                  <button
                    type="button"
                    className="color-trigger"
                    title="选择边框颜色"
                    aria-label="选择边框颜色"
                    aria-expanded={activeColorField === 'border'}
                    aria-controls={COLOR_EDITOR_IDS.border}
                    onClick={() =>
                      toggleColorTarget({ kind: 'config', field: 'border' })
                    }
                  >
                    <span className="kh-color-swatch" style={{ background: draft.borderColor }} />
                  </button>
                }
              />
            }
          />
          {!backgroundIsGradient && (
            <ColorEditorPanel
              id={COLOR_EDITOR_IDS.background}
              open={activeColorField === 'background'}
              label={LABELS[draft.backgroundMode].color}
              color={draft.backgroundColor}
              onChange={(hex) => setFieldColor('background', hex)}
              header={
                <HudRow
                  name={backgroundIsApp ? '背景颜色（应用外观）' : '背景颜色'}
                  desc={
                    backgroundIsApp
                      ? '应用外观会忽略自定义底色；切换为纯色或自定义后可编辑'
                      : 'HUD 的纯色底色；透明度在下面单独设置'
                  }
                  action={
                    <button
                      type="button"
                      className="color-trigger"
                      title={backgroundIsApp ? '应用外观下不生效' : '选择背景颜色'}
                      aria-label="选择背景颜色"
                      aria-expanded={activeColorField === 'background'}
                      aria-controls={COLOR_EDITOR_IDS.background}
                      disabled={backgroundIsApp}
                      onClick={() =>
                        toggleColorTarget({ kind: 'config', field: 'background' })
                      }
                    >
                      <span
                        className="kh-color-swatch"
                        style={{ background: draft.backgroundColor }}
                      />
                    </button>
                  }
                />
              }
            />
          )}
          {backgroundIsGradient && (
            <div className="kh-gradient-field" data-kevin-hud-gradient="true">
              <KevinHudGradientEditor
                value={draft.gradient}
                onChange={(gradient) =>
                  updateConfig({ gradient: normalizeKevinHudGradient(gradient) })
                }
              />
            </div>
          )}
          <RangeRow
            name="背景不透明度"
            desc="0% 完全透明，100% 为实色；只影响背景，文字、图标和边框不变。"
            value={draft.backgroundOpacity}
            min={0}
            max={1}
            step={0.01}
            display={(value) => `${Math.round(value * 100)} %`}
            onChange={(backgroundOpacity) => updateConfig({ backgroundOpacity })}
          />
          <RangeRow
            name="文字、图标和边框不透明度"
            desc="0% 完全透明，100% 为实色；只影响文字、图标和边框，背景不变。"
            value={draft.foregroundOpacity}
            min={0}
            max={1}
            step={0.01}
            display={(value) => `${Math.round(value * 100)} %`}
            onChange={(foregroundOpacity) => updateConfig({ foregroundOpacity })}
          />
          <ColorEditorPanel
            id={COLOR_EDITOR_IDS.text}
            open={activeColorField === 'text'}
            label="文字颜色"
            color={draft.textColor === 'auto' ? textFallback : draft.textColor}
            onChange={(hex) => setFieldColor('text', hex)}
            header={
              <HudRow
                name="文字颜色"
                desc={textIsAuto ? '自动按背景深浅选择黑 / 白' : '自己指定文字颜色'}
                action={
                  <>
                    <Switch
                      checked={textIsAuto}
                      label="自动"
                      title="按背景明暗自动选择黑 / 白文字"
                      onChange={(auto) => {
                        if (auto) {
                          setColorTarget((current) =>
                            current?.kind === 'config' && current.field === 'text'
                              ? null
                              : current
                          )
                          updateConfig({ textColor: 'auto' }, true)
                        } else {
                          updateConfig({ textColor: textFallback }, true)
                        }
                      }}
                    />
                    {!textIsAuto && (
                      <button
                        type="button"
                        className="color-trigger"
                        title="选择文字颜色"
                        aria-label="选择文字颜色"
                        aria-expanded={activeColorField === 'text'}
                        aria-controls={COLOR_EDITOR_IDS.text}
                        onClick={() => toggleColorTarget({ kind: 'config', field: 'text' })}
                      >
                        <span
                          className="kh-color-swatch"
                          style={{ background: textIsAuto ? '#FFFFFF' : draft.textColor }}
                        />
                      </button>
                    )}
                  </>
                }
              />
            }
          />
          <RangeRow
            name="字体缩放"
            desc="整体放大或缩小 HUD 里的文字"
            value={draft.fontScale}
            min={0.8}
            max={1.25}
            step={0.01}
            display={(value) => `${value.toFixed(2)} ×`}
            onChange={(fontScale) => updateConfig({ fontScale })}
          />
          <ColorEditorPanel
            id={COLOR_EDITOR_IDS.icon}
            open={activeColorField === 'icon'}
            label="图标颜色"
            color={draft.iconColor ?? iconFallback}
            onChange={(hex) => setFieldColor('icon', hex)}
            header={
              <HudRow
                name="图标颜色"
                desc={iconIsOriginal ? '保留应用图标的原始颜色' : '给应用图标换成指定颜色'}
                action={
                  <>
                    <Switch
                      checked={iconIsOriginal}
                      label="原色"
                      title="保留应用图标原始颜色"
                      onChange={(original) => {
                        if (original) {
                          setColorTarget((current) =>
                            current?.kind === 'config' && current.field === 'icon'
                              ? null
                              : current
                          )
                          updateConfig({ iconColor: null }, true)
                        } else {
                          updateConfig({ iconColor: iconFallback }, true)
                        }
                      }}
                    />
                    {!iconIsOriginal && (
                      <button
                        type="button"
                        className="color-trigger"
                        title="选择图标颜色"
                        aria-label="选择图标颜色"
                        aria-expanded={activeColorField === 'icon'}
                        aria-controls={COLOR_EDITOR_IDS.icon}
                        onClick={() => toggleColorTarget({ kind: 'config', field: 'icon' })}
                      >
                        <span
                          className="kh-color-swatch"
                          style={{ background: draft.iconColor ?? '#FFFFFF' }}
                        />
                      </button>
                    )}
                  </>
                }
              />
            }
          />

          <div className="settings-group-title">布局与行为</div>
          <HudRow
            name="文字偏移"
            desc="微调开场标题中应用名称的位置（px）"
            action={
              <div className="kh-pair">
                <NumericField
                  label="X"
                  unit="px"
                  value={draft.textOffsetX}
                  min={-200}
                  max={200}
                  onChange={(textOffsetX) => updateConfig({ textOffsetX })}
                />
                <NumericField
                  label="Y"
                  unit="px"
                  value={draft.textOffsetY}
                  min={-200}
                  max={200}
                  onChange={(textOffsetY) => updateConfig({ textOffsetY })}
                />
              </div>
            }
          />
          <HudRow
            name="图标偏移"
            desc="微调开场标题中图标相对名称的位置（px）"
            action={
              <div className="kh-pair">
                <NumericField
                  label="X"
                  unit="px"
                  value={draft.iconOffsetX}
                  min={-200}
                  max={200}
                  onChange={(iconOffsetX) => updateConfig({ iconOffsetX })}
                />
                <NumericField
                  label="Y"
                  unit="px"
                  value={draft.iconOffsetY}
                  min={-200}
                  max={200}
                  onChange={(iconOffsetY) => updateConfig({ iconOffsetY })}
                />
              </div>
            }
          />
          <ToggleRow
            name="吸入启动器"
            desc={
              draft.absorbLauncher
                ? '启动应用时收起启动器，只留游戏画面上的 HUD；退出后可按下一项恢复窗口'
                : '启动应用后保留启动器窗口，不收起；HUD 仍会显示，也没有需要恢复的窗口'
            }
            checked={draft.absorbLauncher}
            label="吸入"
            onChange={(absorbLauncher) => updateConfig({ absorbLauncher }, true)}
          />
          <ToggleRow
            name="退出后恢复启动器"
            desc={
              draft.absorbLauncher
                ? 'HUD 关闭或游戏退出后，把收起的启动器窗口找回来'
                : '已关闭「吸入启动器」，启动器会留在窗口，无需恢复'
            }
            checked={draft.restoreLauncher}
            disabled={!draft.absorbLauncher}
            label="恢复"
            onChange={(restoreLauncher) => updateConfig({ restoreLauncher }, true)}
          />
          <HotkeyRow value={draft.hotkey} onCommit={(hotkey) => updateConfig({ hotkey }, true)} />

          <div className="settings-group-title">指标</div>
          <div className="kh-metrics-note">
            勾选想在游戏里看到的信息。开场标题始终显示应用图标和名称；下面选中的信息保持一行，
            放不下时按上面的「内容放不下时」处理。拖动左侧握把可以排序，聚焦后也能用 Alt+↑ / ↓ 移动。
          </div>
          <div className="kh-style-default">
            <Collapse
              open={defaultStyleOpen}
              header={
                <div className="kh-style-default-head">
                  <div className="kh-metric-main">
                    <div className="kh-metric-name">统一指标样式</div>
                    <div className="kh-metric-desc">
                      {defaultItemStyle.description === 'icon' ? '图标说明' : '文字说明'}
                      {' · '}
                      {defaultItemStyle.orientation === 'vertical' ? '上下排列' : '左右排列'}
                      {' · '}
                      数值 {formatStyleNumber(defaultItemStyle.valueSize)} px
                      {' · '}
                      所有指标共用
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn sm ghost"
                    aria-expanded={defaultStyleOpen}
                    aria-controls="kevin-hud-style-default"
                    title={defaultStyleOpen ? '收起统一指标样式' : '展开统一指标样式'}
                    onClick={toggleDefaultStyle}
                  >
                    {defaultStyleOpen ? '收起统一设置' : '调整统一样式'}
                  </button>
                </div>
              }
            >
              <div className="kh-style-drawer" id="kevin-hud-style-default">
                <div className="kh-drawer-title">
                  统一指标样式<span>所有指标默认都使用这里</span>
                </div>
                <UnifiedItemStyleEditor
                  metricLabel="统一"
                  itemStyle={defaultItemStyle}
                  activeColor={defaultStyleOpen ? colorTarget : null}
                  onToggleColor={toggleColorTarget}
                  onChange={setDefaultItemStyle}
                  onChangeColor={setDefaultItemColor}
                  onReset={resetDefaultItemStyle}
                />
              </div>
            </Collapse>
          </div>
          {selectedMetrics.length === 0 ? (
            <div className="settings-empty">未选择任何指标；HUD 仍会显示背景。</div>
          ) : (
            <div className="kh-metric-list">
              <Sortable
                items={selectedMetrics}
                getKey={(metric) => metric.id}
                onReorder={(ids) =>
                  updateConfig({ metrics: reorderHudMetrics(draftRef.current.metrics, ids) })
                }
                renderItem={(metric, _index, handle) => {
                  const override = getHudMetricStyleOverride(draft.itemStyles, metric.id)
                  const hasOverride = Object.keys(override).length > 0
                  const styleOpen = styleMetric === metric.id
                  const row = (
                    <div className="kh-metric-row">
                      <SortableGrip
                        handle={handle}
                        label="拖动排序；Alt+↑ / ↓ 也可移动"
                      />
                      <div className="kh-metric-main">
                        <div className="kh-metric-name">
                          {metric.label}
                          {hasOverride && <span className="kh-style-badge custom">已覆盖</span>}
                        </div>
                        <div className="kh-metric-desc">{metric.desc}</div>
                      </div>
                      <button
                        type="button"
                        className="btn sm ghost kh-metric-style-toggle"
                        aria-expanded={styleOpen}
                        aria-controls={`kevin-hud-style-${metric.id}`}
                        title={styleOpen ? `收起${metric.label}样式` : `调整${metric.label}样式`}
                        onClick={() => toggleMetricStyle(metric.id)}
                      >
                        {styleOpen ? '收起样式' : '调整样式'}
                        <Icon name="chevronDown" size={14} />
                      </button>
                      <Checkbox
                        checked
                        label="显示"
                        title={`取消显示${metric.label}`}
                        onChange={(enabled) =>
                          updateConfig({
                            metrics: setHudMetricEnabled(
                              draftRef.current.metrics,
                              metric.id,
                              enabled
                            )
                          })
                        }
                      />
                    </div>
                  )

                  const itemStyle: HudSettingsItemStyle = {
                    ...defaultItemStyle,
                    ...override
                  }
                  const reservedWidth = measureKevinHudItemWidth(sizingConfig, metric.id, {
                    appName
                  })
                  const valueReserveWidth = measureKevinHudValueWidth(
                    sizingConfig,
                    metric.id,
                    { appName }
                  )
                  return (
                    <div className="kh-metric-stack">
                      <Collapse open={styleOpen} header={row}>
                        <div
                          className="kh-style-drawer kh-metric-style-drawer"
                          id={`kevin-hud-style-${metric.id}`}
                          data-metric-style={metric.id}
                        >
                          <div className="kh-drawer-title">
                            「{metric.label}」样式
                            <span>{hasOverride ? '已单独调整' : '跟随统一指标样式'}</span>
                          </div>
                          <MetricStyleEditor
                            metric={metric.id}
                            metricLabel={metric.label}
                            itemStyle={itemStyle}
                            baseStyle={defaultItemStyle}
                            override={override}
                            activeColor={styleOpen ? colorTarget : null}
                            reservedWidth={reservedWidth}
                            valueReserveWidth={valueReserveWidth}
                            onToggleColor={toggleColorTarget}
                            onChange={(patch) => setMetricItemStyle(metric.id, patch)}
                            onClearField={(field) => clearMetricStyleField(metric.id, field)}
                            onReset={() => resetMetricItemStyle(metric.id)}
                          />
                        </div>
                      </Collapse>
                    </div>
                  )
                }}
              />
            </div>
          )}
          {availableMetrics.length > 0 && (
            <>
              <div className="check-group-title">可添加</div>
              <div className="kh-metric-available">
                {availableMetrics.map((metric) => (
                  <Checkbox
                    key={metric.id}
                    checked={false}
                    label={metric.label}
                    title={metric.desc}
                    onChange={() =>
                      updateConfig({
                        metrics: setHudMetricEnabled(draftRef.current.metrics, metric.id, true)
                      })
                    }
                  />
                ))}
              </div>
            </>
          )}

          <div className="kh-footer">
            <button
              type="button"
              className={`btn sm${previewOn ? ' primary' : ''}`}
              aria-pressed={previewOn}
              disabled={previewBusy}
              onClick={() => {
                if (previewOn) endPreview()
                else void startPreview()
              }}
            >
              {previewBusy ? '正在打开预览…' : previewOn ? '结束预览' : '预览 HUD'}
            </button>
            <button type="button" className="btn sm ghost" onClick={resetDefaults}>
              重置为默认
            </button>
            <span
              className={`kh-status${statusError ? ' error' : previewOn ? ' live' : ''}`}
              role="status"
              aria-live="polite"
            >
              {previewOn && !statusError && <span className="kh-live-dot" aria-hidden="true" />}
              {statusText}
            </span>
          </div>
        </div>
      </Collapse>
    </div>
  )
}
