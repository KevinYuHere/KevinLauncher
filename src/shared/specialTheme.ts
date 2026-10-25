import {
  LAUNCH_EFFECTS,
  MATERIAL_DEFAULTS,
  type GlassAppearance,
  type GlassMaterial,
  type LaunchEffect,
  type SpecialAreaId,
  type SpecialThemeId,
  type ThemePolicy
} from './types'

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
export const SPECIAL_AREA_GROUPS = ['外壳', '导航', '首页', '更新', '组件', '图库'] as const

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
  { id: 'titlebar', label: '标题栏 / 窗口按钮', group: '外壳', hint: '窗口顶部与最小化 / 关闭按钮', defaultTheme: 'default' },
  { id: 'focusRing', label: '焦点环', group: '外壳', hint: '键盘聚焦时的描边', defaultTheme: 'default' },
  { id: 'textAccent', label: '文字选中 / 链接', group: '外壳', hint: '选中文本与可点击链接', defaultTheme: 'default' },
  { id: 'toast', label: 'Toast', group: '外壳', hint: '右下角的轻提示', defaultTheme: 'default' },
  { id: 'transition', label: '过渡 / 启动画面', group: '外壳', hint: '页面切换与启动特效', defaultTheme: 'default' },
  { id: 'sidebar', label: '侧边栏', group: '导航', hint: '左侧导航栏底色与材质', defaultTheme: 'default' },
  { id: 'navSelected', label: '侧边栏选中项', group: '导航', hint: '当前页的强调块（主题为霆核）', defaultTheme: 'default' },
  { id: 'updateIndicator', label: '设置入口 / 更新指示', group: '导航', hint: '侧边栏底部的更新图标', defaultTheme: 'default' },
  { id: 'cards', label: '游戏卡片', group: '首页', hint: '主页信息卡与游戏图标卡', defaultTheme: 'default' },
  { id: 'launchButton', label: '启动按钮', group: '首页', hint: '启动 / 更新主按钮与左侧霆核', defaultTheme: 'default' },
  { id: 'gamesBar', label: '游戏栏', group: '首页', hint: '顶部游戏图标条的展开与收起', defaultTheme: 'default' },
  { id: 'avatars', label: '头像行', group: '首页', hint: '游戏栏右侧的关联启动条目', defaultTheme: 'default' },
  { id: 'emptyState', label: '空状态', group: '首页', hint: '没有应用 / 没有截图等占位', defaultTheme: 'default' },
  { id: 'updatePage', label: '更新页', group: '更新', hint: '游戏更新的整页视图', defaultTheme: 'default' },
  { id: 'downloadOverlay', label: '下载浮层', group: '更新', hint: '悬停进度环时的详情气泡', defaultTheme: 'default' },
  { id: 'downloadRing', label: '下载进度（霆核）', group: '更新', hint: '侧边栏更新进度环：盾段与轨道弧（启动按钮内的进度环保持默认）', defaultTheme: 'default' },
  { id: 'dialogs', label: '弹窗', group: '组件', hint: '确认框、更新弹窗、查看器', defaultTheme: 'default' },
  { id: 'forms', label: '表单', group: '组件', hint: '输入行、路径与设置表单', defaultTheme: 'default' },
  { id: 'dropdowns', label: '下拉', group: '组件', hint: '选择器展开的菜单', defaultTheme: 'default' },
  { id: 'drawer', label: '抽屉', group: '组件', hint: '启动方式抽屉', defaultTheme: 'default' },
  { id: 'segmented', label: '多选一分段', group: '组件', hint: '分段选择器与滑动指示块', defaultTheme: 'default' },
  { id: 'slider', label: '滑块', group: '组件', hint: '亮度 / 模糊等滑块', defaultTheme: 'default' },
  { id: 'switch', label: '开关', group: '组件', hint: '自动主题等开关', defaultTheme: 'default' },
  { id: 'tabs', label: '标签页', group: '组件', hint: '设置页顶部标签', defaultTheme: 'default' },
  { id: 'inputs', label: '输入框', group: '组件', hint: '文本输入与内联编辑', defaultTheme: 'default' },
  { id: 'clickEffect', label: '点击特效', group: '组件', hint: '点击时从指针处飞出的几何碎片', defaultTheme: 'default' },
  { id: 'gallery', label: '图库', group: '图库', hint: '截图网格与查看器', defaultTheme: 'default' },
  { id: 'skeleton', label: '骨架 / 加载', group: '图库', hint: '图片加载占位', defaultTheme: 'default' }
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
 * Per-app part of a release policy: a forced glass material (with that
 * material's recommended parameters, exactly like switching it in the settings)
 * and a forced launch effect. A missing field leaves the user's choice alone.
 */
export function applyAppThemePolicy<T extends AppThemePolicyTarget>(
  app: T,
  policy: ThemePolicy
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
