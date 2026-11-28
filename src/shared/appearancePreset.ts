import {
  LAUNCH_EFFECTS,
  MATERIAL_DEFAULTS,
  type AppEntry,
  type GlassAppearance,
  type LaunchEffect,
  type SpecialAreaId,
  type SpecialThemeId
} from './types'
import {
  SPECIAL_AREAS,
  isSpecialThemeId,
  type ThemeAssignments,
  type ThemeLocks
} from './specialTheme'

/**
 * Local, named appearance presets.
 *
 * A preset is a stored snapshot of appearance-only settings: the theme colour,
 * glass material + parameters, all independently themed areas, the launch
 * effect and wallpaper dimming. Application lists, launch methods, wallpaper
 * files and every other independent setting are deliberately outside it.
 */
export const APPEARANCE_PRESET_FILE = 'appearance-presets.json'
export const APPEARANCE_PRESET_VERSION = 1
export const APPEARANCE_PRESET_NAME_MAX = 48

export interface AppearancePresetAppearance {
  themeColor: string | null
  autoTheme: boolean
  glass: GlassAppearance
  launchEffect: LaunchEffect
  backgroundDim: number
}

export interface AppearancePresetSnapshot {
  /** Every known area is stored, including `default`, so applying restores it. */
  areas: Record<SpecialAreaId, SpecialThemeId>
  /** Appearance keyed by app id; unknown apps are ignored when applying. */
  apps: Record<string, AppearancePresetAppearance>
}

export interface AppearancePreset extends AppearancePresetSnapshot {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface AppearancePresetSummary {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  appCount: number
  themedAreaCount: number
}

export interface AppearancePresetApplyResult {
  presetName: string
  apps: number
  /** Non-default areas restored (0 means every area is on default). */
  areas: number
}

/** Appearance preset methods merged into `KevinApi` and exposed by preload. */
export interface AppearancePresetApi {
  appearancePresetsList(): Promise<AppearancePresetSummary[]>
  appearancePresetsApply(id: string): Promise<AppearancePresetApplyResult>
  appearancePresetsRemove(id: string): Promise<AppearancePresetSummary[]>
}

/** Structural subset used when applying a snapshot to the real launcher config. */
export interface AppearancePresetTarget {
  apps: Pick<
    AppEntry,
    'id' | 'themeColor' | 'autoTheme' | 'glass' | 'launchEffect' | 'backgroundDim' | 'updatedAt'
  >[]
  launcher?: { themeAreas?: ThemeAssignments; themeLocks?: ThemeLocks }
}

const HEX_COLOR = /^#[a-f\d]{6}$/i
const GLASS_RANGES: Record<Exclude<keyof GlassAppearance, 'material'>, [number, number]> = {
  brightness: [0, 100],
  opacity: [0, 100],
  blur: [0, 60],
  saturation: [50, 200],
  grain: [0, 100],
  refraction: [0, 200],
  panelRefraction: [0, 200],
  edgeWidth: [4, 100],
  highlight: [0, 100],
  highlightAngle: [0, 360],
  dispersion: [0, 100]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isFiniteInRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

const isDate = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))

const isLaunchEffect = (value: unknown): value is LaunchEffect =>
  typeof value === 'string' && LAUNCH_EFFECTS.some((effect) => effect.id === value)

const RESERVED_APP_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const isAppKey = (value: string): boolean =>
  /^[\w-]{1,128}$/.test(value) && !RESERVED_APP_KEYS.has(value)

/** `null` when the name is acceptable, otherwise the Chinese error to show. */
export function appearancePresetNameError(name: unknown): string | null {
  if (typeof name !== 'string') return '预设名称格式不正确'
  const trimmed = name.trim()
  if (!trimmed) return '请输入预设名称'
  if (trimmed.length > APPEARANCE_PRESET_NAME_MAX) {
    return `预设名称不能超过 ${APPEARANCE_PRESET_NAME_MAX} 个字符`
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return '预设名称不能包含换行、制表符等特殊字符'
  return null
}

export function isValidAppearanceGlass(value: unknown): value is GlassAppearance {
  if (!isRecord(value)) return false
  if (typeof value.material !== 'string' || !Object.hasOwn(MATERIAL_DEFAULTS, value.material)) {
    return false
  }
  return Object.entries(GLASS_RANGES).every(([key, [min, max]]) =>
    isFiniteInRange(value[key], min, max)
  )
}

export function normalizePresetAppearance(value: unknown): AppearancePresetAppearance | null {
  if (!isRecord(value)) return null
  const { themeColor, autoTheme, glass, launchEffect, backgroundDim } = value
  if (themeColor !== null && !(typeof themeColor === 'string' && HEX_COLOR.test(themeColor))) return null
  if (typeof autoTheme !== 'boolean') return null
  if (!isValidAppearanceGlass(glass)) return null
  if (!isLaunchEffect(launchEffect)) return null
  if (!isFiniteInRange(backgroundDim, 0, 100)) return null
  return {
    themeColor: themeColor === null ? null : themeColor,
    autoTheme,
    glass: { ...glass },
    launchEffect,
    backgroundDim
  }
}

export function normalizeAppearancePresetSnapshot(value: unknown): AppearancePresetSnapshot | null {
  if (!isRecord(value) || !isRecord(value.areas) || !isRecord(value.apps)) return null
  const areas = {} as Record<SpecialAreaId, SpecialThemeId>
  for (const area of SPECIAL_AREAS) {
    const theme = value.areas[area.id]
    if (theme === undefined) areas[area.id] = 'default'
    else if (isSpecialThemeId(theme)) areas[area.id] = theme
    else return null
  }
  const apps = Object.create(null) as Record<string, AppearancePresetAppearance>
  for (const [id, raw] of Object.entries(value.apps)) {
    if (!isAppKey(id)) return null
    const appearance = normalizePresetAppearance(raw)
    if (!appearance) return null
    apps[id] = appearance
  }
  return { areas, apps }
}

export function normalizeAppearancePreset(value: unknown): AppearancePreset | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || !isAppKey(value.id)) return null
  if (appearancePresetNameError(value.name) !== null) return null
  if (!isDate(value.createdAt) || !isDate(value.updatedAt)) return null
  const snapshot = normalizeAppearancePresetSnapshot(value)
  if (!snapshot) return null
  return {
    id: value.id,
    name: (value.name as string).trim(),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...snapshot
  }
}

/**
 * Validate the on-disk preset file. Unknown/invalid entries are counted but
 * never silently rewritten: the caller must refuse writes so user data survives.
 */
export function normalizeAppearancePresetFile(
  value: unknown
): { presets: AppearancePreset[]; invalid: number } | null {
  if (!isRecord(value)) return null
  if (value.version !== undefined && value.version !== APPEARANCE_PRESET_VERSION) return null
  if (!Array.isArray(value.presets)) return null
  const presets: AppearancePreset[] = []
  const ids = new Set<string>()
  let invalid = 0
  for (const raw of value.presets) {
    const preset = normalizeAppearancePreset(raw)
    if (!preset || ids.has(preset.id)) {
      invalid++
      continue
    }
    ids.add(preset.id)
    presets.push(preset)
  }
  return { presets, invalid }
}

/**
 * Restore a preset into the existing config in place.
 *
 * Only appearance fields are touched. Apps that no longer exist are ignored,
 * and apps created after the snapshot keep their own appearance. Launch
 * methods, wallpapers, linked launches, theme policy records and all other
 * settings are left untouched.
 */
export function applyAppearancePreset(
  target: AppearancePresetTarget,
  preset: AppearancePreset,
  updatedAt = new Date().toISOString()
): { apps: number; areas: number } {
  let apps = 0
  for (const entry of target.apps) {
    if (!Object.hasOwn(preset.apps, entry.id)) continue
    const saved = preset.apps[entry.id]
    if (!saved) continue
    entry.themeColor = saved.themeColor
    entry.autoTheme = saved.autoTheme
    entry.glass = { ...saved.glass }
    entry.launchEffect = saved.launchEffect
    entry.backgroundDim = saved.backgroundDim
    entry.updatedAt = updatedAt
    apps++
  }

  // Keep entries for areas added by a future build; replace every known one.
  const themeAreas: ThemeAssignments = { ...(target.launcher?.themeAreas ?? {}) }
  let areas = 0
  for (const area of SPECIAL_AREAS) {
    const theme = preset.areas[area.id] ?? 'default'
    if (theme === 'default') {
      delete themeAreas[area.id]
    } else {
      themeAreas[area.id] = theme
      areas++
    }
  }
  target.launcher = {
    ...(target.launcher ?? {}),
    themeAreas,
    // Theme locks are no longer used by the settings UI; a preset restores the
    // user's own assignments, so clear stale release locks without touching the
    // policy version.
    themeLocks: {}
  }
  return { apps, areas }
}

export function summarizeAppearancePreset(preset: AppearancePreset): AppearancePresetSummary {
  return {
    id: preset.id,
    name: preset.name,
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
    appCount: Object.keys(preset.apps).length,
    themedAreaCount: SPECIAL_AREAS.filter(
      (area) => (preset.areas[area.id] ?? 'default') !== 'default'
    ).length
  }
}
