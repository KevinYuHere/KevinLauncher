import {
  LAUNCH_EFFECTS,
  MATERIAL_DEFAULTS,
  type FeatureIntro,
  type GlassAppearance,
  type GlassMaterial,
  type LaunchEffect,
  type SpecialAreaId,
  type SpecialThemeId,
  type ThemePolicy
} from './types'
import { isSemVerVersion } from './version'

/**
 * Special-edition theme registry.
 *
 * Everything is data driven: a new theme only needs a `SpecialThemeDefinition`
 * (plus its CSS block), and a new independently themeable surface only needs an
 * entry in `SPECIAL_AREAS` (plus CSS selectors using the `data-special-<area>`
 * attribute written by the renderer). No component may branch on a theme id by
 * hand — the attributes + tokens are the only contract.
 */

/** Visual groups shown in the settings drawer, in display order. */
export const SPECIAL_AREA_GROUPS = ['窗口与提示', '导航', '首页', '更新', '界面元素', '图库'] as const

export type SpecialAreaGroup = (typeof SPECIAL_AREA_GROUPS)[number]

export interface SpecialAreaDefinition {
  id: SpecialAreaId
  label: string
  group: SpecialAreaGroup
  /** Short explanation shown under the row name. */
  hint: string
  /** Theme used when the user never picked one. */
  defaultTheme: SpecialThemeId
}

export interface SpecialThemeDefinition {
  id: SpecialThemeId
  label: string
  /** One-line description for tooltips / release notes. */
  description: string
  /** CSS custom properties applied to `<html>` while this theme is in use. */
  tokens: Record<string, string>
  /**
   * Motion families this theme replaces. The keys are semantic (`jelly`,
   * `dialogIn`, …) so components/animation CSS never branches on a theme id.
   */
  motion: Record<string, string>
}

export const SPECIAL_THEMES: SpecialThemeDefinition[] = [
  {
    id: 'default',
    label: '默认',
    description: '保留启动器原有配色与动效',
    tokens: {},
    motion: {}
  },
  {
    id: 'starsnow',
    label: '霆骇列律',
    description: '霆光霜律 · 电轨、霜盾与极夜星屑',
    tokens: {
      '--sn-purple': '#8b7cf6',
      '--sn-cyan': '#7dd3fc',
      '--sn-gold': '#f5d48a',
      '--sn-deep': '#0b1020',
      '--sn-ice': '#e6f6ff',
      '--sn-aurora': '#7ef0c0',
      '--sn-ease': 'cubic-bezier(0.22, 1, 0.36, 1)',
      '--sn-dur': '260ms',
      '--sn-glow': '0 0 18px rgba(139, 124, 246, 0.28)'
    },
    motion: {
      jelly: 'frost-snap',
      dialogIn: 'shield-open',
      dialogOut: 'shield-close',
      popupIn: 'orbit-slide',
      popupOut: 'frost-fold',
      page: 'star-wipe',
      toast: 'stardust-rise'
    }
  },
  {
    id: 'mitia',
    label: '星轨手记',
    description: '星芒、坐标轴与手记立方 · 米提亚',
    tokens: {
      '--mt-void': '#0e1430',
      '--mt-night': '#1b2350',
      '--mt-violet': '#6c4bd8',
      '--mt-lilac': '#a78bfa',
      '--mt-cyan': '#8fe3ff',
      '--mt-gold': '#e8c87a',
      '--mt-paper': '#f2eeff',
      '--mt-ease': 'cubic-bezier(0.22, 1, 0.36, 1)',
      '--mt-glow': '0 0 18px rgba(108, 75, 216, 0.3)',
      /* 40 px coordinate paper, drawn with two hairlines. */
      '--mt-grid':
        'linear-gradient(rgba(167, 139, 250, 0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(167, 139, 250, 0.07) 1px, transparent 1px)',
      '--mt-grid-size': '40px 40px'
    },
    motion: {
      jelly: 'star-press',
      dialogIn: 'cube-unfold',
      dialogOut: 'cube-fold',
      popupIn: 'axis-slide',
      popupOut: 'axis-retract',
      page: 'plot-curve',
      toast: 'axis-rise'
    }
  }
]

/** Every UI surface that can pick a theme independently (order = settings order). */
export const SPECIAL_AREAS: SpecialAreaDefinition[] = [
  { id: 'titlebar', label: '标题栏 / 窗口按钮', group: '窗口与提示', hint: '窗口顶部、最小化与关闭按钮', defaultTheme: 'default' },
  { id: 'focusRing', label: 'Tab 键定位框', group: '窗口与提示', hint: '按 Tab 键切换按钮或输入框时，当前项外显示的定位框', defaultTheme: 'default' },
  { id: 'textAccent', label: '文字选中 / 链接', group: '窗口与提示', hint: '选中的文字与可点击的链接', defaultTheme: 'default' },
  { id: 'toast', label: '浮动提示', group: '窗口与提示', hint: '右下角短暂出现、随后自动消失的提示条', defaultTheme: 'default' },
  { id: 'transition', label: '页面过渡 / 启动画面', group: '窗口与提示', hint: '页面切换与启动时的动画', defaultTheme: 'default' },
  { id: 'sidebar', label: '侧边栏', group: '导航', hint: '左侧导航栏的底色与材质', defaultTheme: 'default' },
  { id: 'navSelected', label: '侧边栏当前页', group: '导航', hint: '侧边栏中表示当前所在页面的高亮标记', defaultTheme: 'default' },
  { id: 'updateIndicator', label: '设置与更新图标', group: '导航', hint: '侧边栏底部、设置按钮上方的下载更新图标', defaultTheme: 'default' },
  { id: 'cards', label: '游戏卡片', group: '首页', hint: '主页的信息卡与游戏图标卡', defaultTheme: 'default' },
  { id: 'launchButton', label: '启动按钮', group: '首页', hint: '启动 / 更新主按钮及其左侧的圆形光点', defaultTheme: 'default' },
  { id: 'gamesBar', label: '游戏栏', group: '首页', hint: '顶部游戏图标条的展开与收起', defaultTheme: 'default' },
  { id: 'avatars', label: '头像行', group: '首页', hint: '游戏栏右侧的关联启动项', defaultTheme: 'default' },
  { id: 'emptyState', label: '无内容提示', group: '首页', hint: '没有应用、截图等占位画面', defaultTheme: 'default' },
  { id: 'updatePage', label: '更新页', group: '更新', hint: '游戏更新的整页界面', defaultTheme: 'default' },
  { id: 'downloadOverlay', label: '下载详情面板', group: '更新', hint: '鼠标停在进度环上时显示详细进度的小面板', defaultTheme: 'default' },
  { id: 'downloadRing', label: '下载进度环', group: '更新', hint: '侧边栏更新图标的圆形进度环（启动按钮内的进度环不受影响）', defaultTheme: 'default' },
  { id: 'dialogs', label: '弹窗', group: '界面元素', hint: '确认框、更新弹窗和图片查看器', defaultTheme: 'default' },
  { id: 'forms', label: '表单', group: '界面元素', hint: '输入框、路径和设置表单', defaultTheme: 'default' },
  { id: 'dropdowns', label: '下拉菜单', group: '界面元素', hint: '点开下拉按钮后出现的选项列表', defaultTheme: 'default' },
  { id: 'drawer', label: '启动方式面板', group: '界面元素', hint: '从启动按钮展开的启动方式选择面板', defaultTheme: 'default' },
  { id: 'segmented', label: '分段选择', group: '界面元素', hint: '一组并排的选项，点击或拖动高亮标记切换当前选项', defaultTheme: 'default' },
  { id: 'slider', label: '滑块', group: '界面元素', hint: '亮度、模糊等滑块', defaultTheme: 'default' },
  { id: 'switch', label: '开关', group: '界面元素', hint: '自动主题等开关', defaultTheme: 'default' },
  { id: 'tabs', label: '标签页', group: '界面元素', hint: '设置页顶部的标签页', defaultTheme: 'default' },
  { id: 'inputs', label: '输入框', group: '界面元素', hint: '文本输入与就地改名', defaultTheme: 'default' },
  { id: 'clickEffect', label: '点击特效', group: '界面元素', hint: '点击时从鼠标位置散开的几何碎片', defaultTheme: 'default' },
  { id: 'gallery', label: '图库', group: '图库', hint: '截图网格与全屏查看器', defaultTheme: 'default' },
  { id: 'skeleton', label: '加载占位', group: '图库', hint: '图片加载完成前显示的占位块', defaultTheme: 'default' }
]

const THEME_BY_ID = new Map(SPECIAL_THEMES.map((theme) => [theme.id, theme]))
const AREA_BY_ID = new Map(SPECIAL_AREAS.map((area) => [area.id, area]))

export type ThemeAssignments = Partial<Record<SpecialAreaId, SpecialThemeId>>
export type ThemeLocks = Partial<Record<SpecialAreaId, SpecialThemeId>>

/** True for a theme id that exists in the registry. */
export function isSpecialThemeId(value: unknown): value is SpecialThemeId {
  return typeof value === 'string' && THEME_BY_ID.has(value)
}

/** True for a registered area id. */
export function isSpecialAreaId(value: unknown): value is SpecialAreaId {
  return typeof value === 'string' && AREA_BY_ID.has(value as SpecialAreaId)
}

/** Display name of a theme id (`default` when unknown). */
export function specialThemeLabel(id: SpecialThemeId | undefined): string {
  return THEME_BY_ID.get(id ?? 'default')?.label ?? '默认'
}

/** Definition of a theme id (`default` when unknown). */
export function specialThemeDefinition(id: SpecialThemeId | undefined): SpecialThemeDefinition {
  return THEME_BY_ID.get(id ?? 'default') ?? SPECIAL_THEMES[0]
}

/** Resolve one area; unknown/missing values fall back to `default`. */
export function resolveAreaTheme(
  assignments: ThemeAssignments | undefined,
  area: SpecialAreaId
): SpecialThemeId {
  const id = assignments?.[area]
  return isSpecialThemeId(id) ? id : 'default'
}

/** Applied value shown by the bulk picker when all areas agree. */
export function uniformTheme(assignments: ThemeAssignments | undefined): SpecialThemeId {
  const first = resolveAreaTheme(assignments, SPECIAL_AREAS[0].id)
  return SPECIAL_AREAS.every(area => resolveAreaTheme(assignments, area.id) === first) ? first : 'default'
}

/** Set one area (removes the entry when switching back to `default`). */
export function withAreaTheme(
  assignments: ThemeAssignments | undefined,
  area: SpecialAreaId,
  themeId: SpecialThemeId
): ThemeAssignments {
  const next: ThemeAssignments = { ...(assignments ?? {}) }
  if (themeId === 'default') delete next[area]
  else next[area] = themeId
  return next
}

/**
 * Bulk set: one theme for every area (`default` clears the assignments).
 * Locked areas are always kept exactly as the release policy demands, so a
 * global change can never fight with "由开发者指定".
 */
export function withAllThemes(
  _assignments: ThemeAssignments | undefined,
  themeId: SpecialThemeId,
  locks: ThemeLocks = {}
): ThemeAssignments {
  const next: ThemeAssignments = {}
  for (const area of SPECIAL_AREAS) {
    const lock = locks[area.id]
    if (lock) {
      next[area.id] = lock
      continue
    }
    if (themeId !== 'default') next[area.id] = themeId
  }
  // Keep unknown-but-valid entries from a future area registry? There are none
  // today; a full "apply to all" intentionally starts from a clean map.
  return next
}

/**
 * Merge an already-validated policy into the user's assignments. Pure, so the
 * release-policy behaviour is unit-tested instead of only running at startup.
 *
 * A policy **sets values once** and never takes ownership of them: there are no
 * locks, so the user can change any area afterwards. `locks` in the policy file
 * is accepted for older files but ignored.
 */
export function applyThemePolicy(
  assignments: ThemeAssignments | undefined,
  _locks: ThemeLocks | undefined,
  policy: ThemePolicy
): { assignments: ThemeAssignments; locks: ThemeLocks } {
  const nextAssignments: ThemeAssignments = { ...(assignments ?? {}) }
  const areas =
    policy.areas === 'all'
      ? SPECIAL_AREAS.map((area) => area.id)
      : policy.areas.filter(isSpecialAreaId)
  const mode = policy.mode ?? 'force'
  for (const area of areas) {
    const current = resolveAreaTheme(nextAssignments, area)
    if (mode === 'default' && current !== 'default') continue
    if (policy.themeId === 'default') delete nextAssignments[area]
    else nextAssignments[area] = policy.themeId
  }
  return { assignments: nextAssignments, locks: {} }
}

/**
 * Optional pieces carried by a newer release payload. Unlike the legacy
 * `ThemePolicy`, every part is optional so a release can opt into only the
 * theme areas, only the material, or only the launch effect.
 */
export interface ReleaseThemePolicy {
  themeId?: SpecialThemeId
  areas?: 'all' | SpecialAreaId[]
  mode?: 'force' | 'default'
  material?: GlassMaterial
  launchEffect?: LaunchEffect
}

export interface ReleaseUpgradePolicy {
  version: string
  theme: ReleaseThemePolicy | null
  intro: FeatureIntro | null
}

/**
 * Per-app part of a release policy: a forced glass material (with that
 * material's recommended parameters, exactly like switching it in the settings)
 * and a forced launch effect. A missing field leaves the user's choice alone.
 */
export function applyAppThemePolicy<T extends AppThemePolicyTarget>(
  app: T,
  policy: Pick<ReleaseThemePolicy, 'material' | 'launchEffect'>
): { app: T; changed: boolean } {
  let next = app
  let changed = false
  if (policy.material && app.glass.material !== policy.material) {
    next = { ...next, glass: { ...MATERIAL_DEFAULTS[policy.material] } }
    changed = true
  }
  if (policy.launchEffect && app.launchEffect !== policy.launchEffect) {
    next = { ...next, launchEffect: policy.launchEffect }
    changed = true
  }
  return { app: next, changed }
}

/**
 * A release policy only takes effect on the app version it was written for.
 *
 * `theme-policy.json` travels inside `app-<version>/`; a later release that
 * ships no policy (or a copy of an older one) must not touch user data again.
 */
export function policyTargetsVersion(policy: ThemePolicy, version: string): boolean {
  return policy.version === version
}

/** The bits of an app entry a release policy can replace. */
export interface AppThemePolicyTarget {
  glass: GlassAppearance
  launchEffect: LaunchEffect
}

/** Number of areas currently using a non-default theme (for the settings row). */
export function themedAreaCount(assignments: ThemeAssignments | undefined): number {
  return SPECIAL_AREAS.filter((area) => resolveAreaTheme(assignments, area.id) !== 'default')
    .length
}

/**
 * Normalise a `theme-policy.json` payload. Returns `null` for anything that is
 * not a usable policy: a broken file must never change the user's layout.
 *
 * `material` / `launchEffect` / `critical` are optional. An unknown value is
 * dropped instead of rejecting the whole policy (a typo in an extra field must
 * not cost the user the theme).
 */
export function normalizeThemePolicy(raw: unknown): ThemePolicy | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<ThemePolicy>
  const version = typeof value.version === 'string' ? value.version.trim() : ''
  if (!version || !isSpecialThemeId(value.themeId)) return null
  const areas =
    value.areas === 'all'
      ? 'all'
      : Array.isArray(value.areas)
        ? value.areas.filter(isSpecialAreaId)
        : null
  if (!areas || (areas !== 'all' && areas.length === 0)) return null
  const mode = value.mode === 'default' ? 'default' : 'force'
  const materials = Object.keys(MATERIAL_DEFAULTS) as GlassMaterial[]
  const material =
    typeof value.material === 'string' && materials.includes(value.material as GlassMaterial)
      ? (value.material as GlassMaterial)
      : undefined
  const launchEffect =
    typeof value.launchEffect === 'string' &&
    LAUNCH_EFFECTS.some((effect) => effect.id === value.launchEffect)
      ? (value.launchEffect as LaunchEffect)
      : undefined
  return {
    version,
    themeId: value.themeId,
    areas,
    locked: value.locked === true,
    mode,
    ...(material ? { material } : {}),
    ...(launchEffect ? { launchEffect } : {}),
    ...(value.critical === true ? { critical: true } : {})
  }
}

/** Normalise the optional theme/material/effect part of a release payload. */
export function normalizeReleaseThemePolicy(raw: unknown): ReleaseThemePolicy | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const themeId = isSpecialThemeId(value.themeId) ? value.themeId : undefined
  const areas =
    value.areas === 'all'
      ? 'all'
      : Array.isArray(value.areas)
        ? value.areas.filter(isSpecialAreaId)
        : undefined
  const mode = value.mode === 'default' ? 'default' : 'force'
  const materials = Object.keys(MATERIAL_DEFAULTS) as GlassMaterial[]
  const material =
    typeof value.material === 'string' && materials.includes(value.material as GlassMaterial)
      ? (value.material as GlassMaterial)
      : undefined
  const launchEffect =
    typeof value.launchEffect === 'string' &&
    LAUNCH_EFFECTS.some((effect) => effect.id === value.launchEffect)
      ? (value.launchEffect as LaunchEffect)
      : undefined
  const hasTheme = !!themeId &&
    (areas === 'all' || (Array.isArray(areas) && areas.length > 0))
  if (!hasTheme && !material && !launchEffect) return null
  return {
    ...(hasTheme ? { themeId, areas, mode } : {}),
    ...(material ? { material } : {}),
    ...(launchEffect ? { launchEffect } : {})
  }
}

/** Normalise the introduction content; an absent/invalid block is simply off. */
export function normalizeFeatureIntro(raw: unknown): FeatureIntro | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const text = (candidate: unknown): string | null =>
    typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null
  const title = text(value.title)
  if (!title) return null
  const body = text(value.body)
  const features = Array.isArray(value.features)
    ? value.features.map(text).filter((line): line is string => !!line).slice(0, 8)
    : []
  // A title alone would render an empty dialog, so it is not a usable intro.
  if (!body && features.length === 0) return null
  const buttonLabel = text(value.buttonLabel)
  return {
    title: title.slice(0, 120),
    body: body?.slice(0, 2000) ?? null,
    features: features.map((line) => line.slice(0, 240)),
    buttonLabel: buttonLabel?.slice(0, 24) ?? null
  }
}

/**
 * Normalise a version payload's combined one-time actions.
 *
 * The flat theme fields stay compatible with existing `theme-policy.json`
 * files. `intro` is independent: a file may carry only the introduction, only
 * a theme/material/effect patch, or both. A non-SemVer target is rejected so
 * the policy can only apply to the exact installed release.
 */
export function normalizeReleaseUpgradePolicy(raw: unknown): ReleaseUpgradePolicy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const version = typeof value.version === 'string' ? value.version.trim() : ''
  if (!isSemVerVersion(version)) return null
  const theme = normalizeReleaseThemePolicy(raw)
  const intro = normalizeFeatureIntro(value.intro)
  if (!theme && !intro) return null
  return { version, theme, intro }
}
