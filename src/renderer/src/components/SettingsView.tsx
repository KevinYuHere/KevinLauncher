import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode
} from 'react'
import type {
  AddonDescriptor,
  AfterLaunchAction,
  AppEntry,
  AppSettingsPatch,
  CacheKind,
  AutoStartMode,
  CloseAction,
  GlassAppearance,
  GlassMaterial,
  GlassPatch,
  LauncherSettings,
  LauncherBehaviorPatch,
  LauncherFontScript,
  SpecialThemeId,
  UpdateChannel,
  UsageReport
} from '@shared/types'
import { DEFAULT_GLASS_APPEARANCE, MATERIAL_DEFAULTS } from '@shared/types'
import { currentWallpaper, isVideoFile } from '@shared/appEntry'
import { dataErrorDetails } from '@shared/dataErrors'
import { formatBytes } from '../format'
import { trialBuild } from '@shared/buildIdentity'
import { brandUrl, defaultIconUrl, iconUrl } from '../media'
import { applyGlass } from '../theme'
import { useDebouncedEntitySave } from '../useDebouncedEntitySave'
import { showToast } from './toast'
import AppearancePresetsSection from './AppearancePresetsSection'
import ColorPicker from './ColorPicker'
import Collapse from './Collapse'
import IconPicker from './IconPicker'
import InlineEdit from './InlineEdit'
import Icon from './Icon'
import Segmented from './Segmented'
import Select from './Select'
import Switch from './Switch'

import { SPECIAL_AREAS, SPECIAL_AREA_GROUPS, SPECIAL_THEMES, specialThemeLabel, themedAreaCount, uniformTheme, withAllThemes, withAreaTheme } from '@shared/specialTheme'

/** Project repository (shown in the "About" section). */
const REPO_URL = 'https://github.com/KevinYuHere/KevinLauncher'

/** Third-party libraries this launcher actually uses at runtime / build time. */
const USED_LIBRARIES: { name: string; note: string }[] = [
  { name: 'Electron 44', note: 'MIT · 应用运行环境（窗口、界面与安全桥接）' },
  { name: 'React 18 + ReactDOM', note: 'MIT · 界面构建与渲染' },
  { name: 'fzstd', note: 'MIT · 解压游戏更新数据（zstd）' },
  { name: '@electron-toolkit/preload、@electron-toolkit/utils', note: 'MIT · 窗口与后台通信工具' },
  { name: 'HDiffPatch（hpatchz.exe）', note: 'MIT · 应用游戏更新补丁（增量更新）' },
  { name: 'electron-vite、Vite、electron-builder', note: 'MIT · 开发、构建与打包' },
  { name: 'TypeScript、Vitest', note: 'Apache-2.0 / MIT · 类型检查与测试' }
]

/** Projects whose behaviour / protocol flow this launcher was modelled on. */
const REFERENCED_PROJECTS: { name: string; note: string; url: string }[] = [
  {
    name: 'Starward',
    note: 'MIT · 米家启动器功能布局与接口流程的重要参考',
    url: 'https://github.com/Scighost/Starward'
  },
  {
    name: 'HDiffPatch',
    note: 'MIT · 增量更新思路与补丁工具来源',
    url: 'https://github.com/sisong/HDiffPatch'
  }
]

/** Short label + description for each glass material. */
const GLASS_MATERIAL_LABEL: Record<GlassMaterial, string> = {
  blur: '毛玻璃',
  mica: '云母',
  liquid: '液态',
  shine: '高光',
  starfrost: '星霜',
  astral: '星轨'
}

const GLASS_MATERIAL_DESC: Record<GlassMaterial, string> = {
  blur: '毛玻璃：经典磨砂质感',
  mica: '云母：更致密的磨砂质感',
  liquid: '液态玻璃：边缘像透镜一样放大背景',
  shine: '高光：液态玻璃边缘随周围颜色泛出高光',
  starfrost: '星霜：碎晶三角、星屑微光与紫青虹彩',
  astral: '星轨：分子纹理、金色描边与深紫底色'
}

// Settings page with two tabs that slide on the card itself (so the frosted
// glass behind stays put): per-app appearance/background, and launcher-wide
// icon/font/behavior/backup. All values are controlled by App.tsx.
interface SettingsViewProps {
  entry: AppEntry | null
  addons: AddonDescriptor[]
  onBack: () => void
  /** Merge a partial change into the app (name / addon / dirs / monitors …). */
  onPatchEntry: (patch: AppSettingsPatch) => void
  onPickIcon: () => void
  onResetIcon: () => void
  onRemove: () => void
  /** Jump to a module's settings section (auto-expanded). */
  onOpenModuleSettings: (section: 'launch' | 'wallpaper') => void
  launcher: LauncherSettings
  fonts: string[]
  version: string
  onPickLauncherIcon: () => void
  onClearLauncherIcon: () => void
  onSetLauncherFont: (script: LauncherFontScript, family: string | null) => void
  onSetBehavior: (patch: LauncherBehaviorPatch) => void
  onExportData: () => void
  onImportData: () => void
  /** Current data directory (config, playtime, gacha, icons …). */
  dataDir: string
  onChangeDataDir: () => void
  /** Disk usage of the cleanable caches. */
  usage: UsageReport | null
  cleaningUsage: boolean
  onCleanUsage: (kinds: CacheKind[]) => void
  /** Manually check GitHub Releases for a newer launcher version. */
  onCheckUpdate: () => void
  checkingUpdate: boolean
  /** Result hint of the last manual check (empty until one ran). */
  updateCheckText: string
  /** Copy the launcher logs to a directory the user chooses. */
  onExportLogs: () => void
}

function Row({
  name,
  desc,
  action
}: {
  name: string
  desc?: string
  action?: ReactNode
}): ReactElement {
  return (
    <div className="settings-row">
      <div className="settings-main">
        <div className="settings-name">{name}</div>
        {desc && <div className="settings-desc">{desc}</div>}
      </div>
      {action && <div className="settings-action">{action}</div>}
    </div>
  )
}

function RangeRow({
  name,
  value,
  min,
  max,
  suffix,
  hint,
  onChange
}: {
  name: string
  value: number
  min: number
  max: number
  suffix: string
  /** Short explanation of what this setting does. */
  hint?: string
  onChange: (value: number) => void
}): ReactElement {
  return (
    <Row
      name={name}
      desc={hint}
      action={
        <div className="range-row">
          <span className="range-value">
            {value}
            {suffix}
          </span>
          <input
            className="slider"
            type="range"
            min={min}
            max={max}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        </div>
      }
    />
  )
}

/** One font row — only requests the font face once it scrolls into view. */
function FontItem({
  name,
  active,
  onPick
}: {
  name: string
  active: boolean
  onPick: () => void
}): ReactElement {
  const ref = useRef<HTMLButtonElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <button
      ref={ref}
      className={`font-item${active ? ' active' : ''}`}
      style={visible ? { fontFamily: name } : undefined}
      onClick={onPick}
    >
      {name}
    </button>
  )
}

export default function SettingsView({
  entry,
  addons,
  onBack,
  onPatchEntry,
  onPickIcon,
  onResetIcon,
  onRemove,
  onOpenModuleSettings,
  launcher,
  fonts,
  version,
  onPickLauncherIcon,
  onClearLauncherIcon,
  onSetLauncherFont,
  onSetBehavior,
  onExportData,
  onImportData,
  dataDir,
  onChangeDataDir,
  usage,
  cleaningUsage,
  onCleanUsage,
  onCheckUpdate,
  checkingUpdate,
  updateCheckText,
  onExportLogs
}: SettingsViewProps): ReactElement {
  const [selectedTab, setTab] = useState<'game' | 'launcher'>(entry ? 'game' : 'launcher')
  const tab = entry ? selectedTab : 'launcher'
  const entryId = entry?.id
  const [dir, setDir] = useState(1)
  const [fontTarget, setFontTarget] = useState<LauncherFontScript | null>(null)
  const [showColor, setShowColor] = useState(false)
  const [glassOpen, setGlassOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [themeOpen, setThemeOpen] = useState(false)
  const appliedTheme = uniformTheme(launcher.themeAreas)
  const [draftTheme, setBulkTheme] = useState<SpecialThemeId | null>(null)
  const bulkTheme = draftTheme ?? appliedTheme
  useEffect(() => setBulkTheme(null), [appliedTheme])
  const autoTheme = entry?.autoTheme ?? true
  const currentIcon = iconUrl(entry?.iconFile ?? null)
  const wallpaper = entry ? currentWallpaper(entry) : null
  const canExtractTheme = !!wallpaper && !isVideoFile(wallpaper.file)
  const themedCount = themedAreaCount(launcher.themeAreas)
  const themedNames = [
    ...new Set(
      SPECIAL_AREAS.map((area) => launcher.themeAreas[area.id]).filter(
        (id): id is SpecialThemeId => !!id && id !== 'default'
      )
    )
  ].map((id) => specialThemeLabel(id))
  const themeSummary =
    themedCount === 0
      ? '默认（未套用主题）'
      : `${themedNames.join(' + ')} · ${themedCount}/${SPECIAL_AREAS.length} 个界面区域`

  const pickDir = async (kind: 'game' | 'shot'): Promise<void> => {
    const path = await window.api.pickDirectory()
    if (!path) return
    onPatchEntry(kind === 'game' ? { gameDirectory: path } : { screenshotDirectory: path })
  }
  // Live glass editing: apply immediately (so dragging feels instant) and
  // persist once the user stops (debounced), without re-rendering the whole app.
  const [glass, setGlass] = useState<GlassAppearance>(entry?.glass ?? DEFAULT_GLASS_APPEARANCE)
  const glassRef = useRef<GlassAppearance>(entry?.glass ?? DEFAULT_GLASS_APPEARANCE)
  const glassRaf = useRef(0)
  const glassSaving = useRef(false)
  const glassSaveRevision = useRef(0)
  const [savingGlass, setSavingGlass] = useState(false)
  const scheduleSave = useDebouncedEntitySave()

  useLayoutEffect(() => {
    const next = entry?.glass ?? DEFAULT_GLASS_APPEARANCE
    glassRef.current = next
    setGlass(next)
    return () => {
      cancelAnimationFrame(glassRaf.current)
      glassRaf.current = 0
    }
  }, [entryId])

  // Applying an appearance preset changes the persisted glass while the same
  // app stays selected. Resync only when no slider save is in flight, so a
  // background app refresh cannot clobber an unsaved drag.
  useEffect(() => {
    if (!entryId || glassSaving.current) return
    const next = entry?.glass ?? DEFAULT_GLASS_APPEARANCE
    if (JSON.stringify(next) === JSON.stringify(glassRef.current)) return
    glassRef.current = next
    setGlass(next)
    applyGlass(next)
  }, [entry?.glass, entryId])

  const updateGlass = useCallback(
    (patch: GlassPatch): void => {
      if (!entryId) return
      // Switching material loads that material's recommended parameters.
      const next =
        patch.material && patch.material !== glassRef.current.material
          ? { ...MATERIAL_DEFAULTS[patch.material] }
          : { ...DEFAULT_GLASS_APPEARANCE, ...glassRef.current, ...patch }
      const revision = ++glassSaveRevision.current
      glassRef.current = next
      if (!glassSaving.current) {
        glassSaving.current = true
        setSavingGlass(true)
      }
      setGlass(next)
      // Coalesce the (heavier) live preview to one per frame so dragging the
      // sliders stays smooth.
      if (!glassRaf.current) {
        glassRaf.current = requestAnimationFrame(() => {
          glassRaf.current = 0
          applyGlass(glassRef.current)
        })
      }
      scheduleSave(entryId, 200, () => {
        void window.api
          .setGlass(entryId, next)
          .catch((error) => {
            const detail = dataErrorDetails(error)?.message ??
              (error instanceof Error ? error.message : String(error))
            showToast(`玻璃材质保存失败：${detail}`)
          })
          .finally(() => {
            // A newer drag may have queued another save while this one was in
            // flight; only the newest save may clear the pending state.
            if (glassSaveRevision.current !== revision) return
            glassSaving.current = false
            setSavingGlass(false)
          })
      })
    },
    [entryId, scheduleSave]
  )

  const tabPanelRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const tabAnimMounted = useRef(false)

  const switchTab = (next: 'game' | 'launcher'): void => {
    if (next === tab) return
    setDir(next === 'launcher' ? 1 : -1)
    setTab(next)
  }

  // Slide the panel on tab change — the same translate-only transition the top
  // views use. Not `opacity`, which would make the glass card (backdrop-filter)
  // flash; a stable element also avoids the layout drift seen after repeat use.
  useEffect(() => {
    const el = tabPanelRef.current
    if (!el) return
    if (!tabAnimMounted.current) {
      tabAnimMounted.current = true
      return
    }
    el.classList.remove('tab-anim-run')
    void el.offsetWidth
    el.classList.add('tab-anim-run')
    pageRef.current?.scrollTo({ top: 0 })
  }, [tab])

  const afterLaunchDesc: Record<AfterLaunchAction, string> = {
    none: '应用打开后，启动器保持现状',
    minimize: '启动器最小化到任务栏，应用继续运行',
    tray: '启动器收进系统托盘，点击托盘图标可恢复',
    close: '关闭启动器窗口（按上方关闭按钮的设置处理）'
  }

  const autoStartDesc: Record<AutoStartMode, string> = {
    off: '不随 Windows 启动',
    window: '登录 Windows 后自动打开启动器窗口',
    tray: '登录后静默启动到系统托盘，不显示窗口'
  }

  return (
    <div className="page" ref={pageRef}>
      <div className="page-header">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-subtitle">{tab === 'game' && entry ? `应用 · ${entry.name}` : '启动器本体'}</p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={onBack}>
            返回主页
          </button>
        </div>
      </div>

      <div className="page-body">
        {entry && <Segmented
          variant="tab"
          value={tab}
          onChange={(value) => switchTab(value as 'game' | 'launcher')}
          options={[
            { value: 'game', label: '应用设置' },
            { value: 'launcher', label: '启动器设置' }
          ]}
        />}

        <div
          ref={tabPanelRef}
          className="tab-panel"
          style={{ '--tab-x': `${dir * 26}px` } as CSSProperties}
        >
          {tab === 'game' && entry ? (
            <div className="settings">
              <div className="settings-group-title">基本信息</div>
              <IconPicker
                small
                src={currentIcon}
                label="应用图标"
                desc="可选图片，或从 exe / bat / lnk 提取图标；选好后可拖动、缩放并截取方形区域。"
                onPick={onPickIcon}
                onClear={onResetIcon}
              />

              <Row
                name="显示名称"
                desc="主页与列表中的应用名称"
                action={
                  <InlineEdit
                    value={entry.name}
                    placeholder="我的应用"
                    onCommit={(value) => onPatchEntry({ name: value })}
                  />
                }
              />
              <Row
                name="绑定游戏模块"
                desc={addons.find((a) => a.id === entry.addonId)?.name ?? '未绑定（普通应用）'}
                action={
                  <Select
                    value={entry.addonId ?? ''}
                    options={[
                      { value: '', label: '（不绑定）' },
                      ...addons.map((a) => ({ value: a.id as string, label: a.name }))
                    ]}
                    onChange={(value) =>
                      onPatchEntry({
                        addonId: value === '' ? null : (value as AddonDescriptor['id'])
                      })
                    }
                  />
                }
              />
              <Row
                name="启动方式"
                desc="设置启动文件、参数和默认启动方式，也可让程序以管理员身份运行（在「模块管理」中设置）"
                action={
                  <button className="btn sm" onClick={() => onOpenModuleSettings('launch')}>
                    设置启动方式
                  </button>
                }
              />
              <Row
                name="壁纸设置"
                desc="管理壁纸与轮换，调整模糊和压暗效果"
                action={
                  <button className="btn sm" onClick={() => onOpenModuleSettings('wallpaper')}>
                    设置壁纸
                  </button>
                }
              />

              <Collapse
                open={advancedOpen}
                header={
                  <Row
                    name="高级设置"
                    desc={advancedOpen ? '收起高级选项' : '游戏目录、截图目录与进程跟踪'}
                    action={
                      <button
                        className={`btn sm ghost module-caret${advancedOpen ? ' open' : ''}`}
                        title={advancedOpen ? '收起高级设置' : '展开高级设置'}
                        aria-label={advancedOpen ? '收起高级设置' : '展开高级设置'}
                        aria-expanded={advancedOpen}
                        onClick={() => setAdvancedOpen((v) => !v)}
                      >
                        <Icon name="chevronDown" size={16} />
                      </button>
                    }
                  />
                }
              >
                  {entry.addonId != null && (
                    <Row
                      name="游戏目录"
                      desc={entry.gameDirectory ?? '未设置（更新检测、预下载等游戏功能需要）'}
                      action={
                        <div className="media-row" style={{ gap: 8 }}>
                          <button className="btn sm" onClick={() => void pickDir('game')}>
                            选择目录…
                          </button>
                          {entry.gameDirectory && (
                            <button
                              className="btn sm ghost"
                              onClick={() => onPatchEntry({ gameDirectory: null })}
                            >
                              清除目录
                            </button>
                          )}
                        </div>
                      }
                    />
                  )}
                  <Row
                    name="截图目录"
                    desc={entry.screenshotDirectory ?? '未设置（图库会读取这里的截图）'}
                    action={
                      <div className="media-row" style={{ gap: 8 }}>
                        <button className="btn sm" onClick={() => void pickDir('shot')}>
                          选择目录…
                        </button>
                        {entry.screenshotDirectory && (
                          <button
                            className="btn sm ghost"
                            onClick={() => onPatchEntry({ screenshotDirectory: null })}
                          >
                            清除目录
                          </button>
                        )}
                      </div>
                    }
                  />
                  <Row
                    name="跟踪进程名"
                    desc="一般不用填写。用脚本或快捷方式启动时，填写游戏目录内实际运行的进程名，启动器才能确认游戏已运行；多个用英文逗号分隔"
                    action={
                      <InlineEdit
                        className="wide"
                        value={entry.monitorProcessNames.join(', ')}
                        placeholder="例如：YuanShen.exe"
                        onCommit={(v) =>
                          onPatchEntry({
                            monitorProcessNames: v
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean)
                          })
                        }
                      />
                    }
                  />
              </Collapse>

              <div className="settings-group-title">外观</div>
              <Collapse
                open={!autoTheme && showColor}
                header={
                  <Row
                    name="主题色"
                    desc={autoTheme
                      ? '自动从当前壁纸提取'
                      : `自定义主题色${entry.themeColor ? `（${entry.themeColor}）` : '（默认品牌蓝）'}`}
                    action={
                      <div className="media-row" style={{ gap: 8 }}>
                        <Switch
                          checked={autoTheme}
                          label="自动"
                          title="自动从当前壁纸提取主题色"
                          onChange={(value) => void window.api.setAutoTheme(entry.id, value)}
                        />
                        {!autoTheme && (
                          <>
                            <button
                              type="button"
                              className="color-trigger"
                              title={showColor ? '收起主题色选择' : '自定义主题色'}
                              aria-label={showColor ? '收起主题色选择' : '自定义主题色'}
                              aria-expanded={showColor}
                              aria-controls="theme-color-editor"
                              onClick={() => setShowColor((v) => !v)}
                            >
                              <span
                                className="color-trigger-fill"
                                style={{ background: entry.themeColor ?? '#3778e5' }}
                              />
                            </button>
                            <button
                              className="btn sm"
                              disabled={!canExtractTheme}
                              onClick={() => void window.api.extractThemeColor(entry.id)}
                              title={canExtractTheme ? '从当前壁纸提取主题色' : '视频壁纸或未设置壁纸时无法提取'}
                            >
                              {canExtractTheme ? '从当前壁纸提取' : '当前壁纸不可提取'}
                            </button>
                            <button
                              className="btn sm ghost"
                              onClick={() => void window.api.setThemeColor(entry.id, null)}
                            >
                              恢复默认色
                            </button>
                          </>
                        )}
                      </div>
                    }
                  />
                }
              >
                <div className="settings-color-panel" id="theme-color-editor" role="group"
                  aria-label="自定义主题色">
                  <ColorPicker
                    value={entry.themeColor}
                    onChange={(hex) => void window.api.setThemeColor(entry.id, hex)}
                  />
                </div>
              </Collapse>
              <Collapse
                open={glassOpen}
                header={
                  <Row
                    name="玻璃材质"
                    desc={GLASS_MATERIAL_DESC[glass.material]}
                    action={
                      <div className="media-row" style={{ gap: 8 }}>
                        <Segmented
                          value={glass.material}
                          onChange={(value) => updateGlass({ material: value as GlassMaterial })}
                          options={(['blur', 'mica', 'liquid', 'shine', 'starfrost', 'astral'] as GlassMaterial[]).map(
                            (material) => ({ value: material, label: GLASS_MATERIAL_LABEL[material] })
                          )}
                        />
                        <button
                          className={`btn sm ghost module-caret${glassOpen ? ' open' : ''}`}
                          title="调整玻璃细节"
                          aria-label="调整玻璃细节"
                          aria-expanded={glassOpen}
                          onClick={() => setGlassOpen((v) => !v)}
                        >
                          <Icon name="chevronDown" size={16} />
                        </button>
                        <button
                          className="btn sm ghost"
                          title="恢复当前材质的推荐参数"
                          aria-label="恢复当前材质的推荐参数"
                          onClick={() => updateGlass({ ...MATERIAL_DEFAULTS[glass.material] })}
                        >
                          重置参数
                        </button>
                      </div>
                    }
                  />
                }
              >
              <RangeRow
                name="玻璃亮度"
                value={glass.brightness}
                hint="调整玻璃底色明暗：0 偏黑，100 偏白"
                min={0}
                max={100}
                suffix=""
                onChange={(brightness) => updateGlass({ brightness })}
              />
              <RangeRow
                name="玻璃通透度"
                value={glass.opacity}
                hint="数值越大越能透出后面的壁纸；100 时只保留模糊等背景效果"
                min={0}
                max={100}
                suffix=" %"
                onChange={(opacity) => updateGlass({ opacity })}
              />
              <RangeRow
                name="玻璃模糊"
                value={glass.blur}
                hint="数值越大，玻璃后面的壁纸越朦胧"
                min={0}
                max={60}
                suffix=" px"
                onChange={(blur) => updateGlass({ blur })}
              />
              {(glass.material === 'blur' || glass.material === 'mica') && (
                <RangeRow
                  name="背景色彩浓度"
                  value={glass.saturation}
                  hint="让透出的壁纸颜色更淡或更鲜艳（毛玻璃 / 云母）"
                  min={50}
                  max={200}
                  suffix=" %"
                  onChange={(saturation) => updateGlass({ saturation })}
                />
              )}
              {(glass.material === 'mica' ||
                glass.material === 'starfrost' ||
                glass.material === 'astral') && (
                <RangeRow
                  name="颗粒"
                  value={glass.grain}
                  hint={
                    glass.material === 'starfrost'
                      ? '碎晶三角与星屑微光的强度'
                      : glass.material === 'astral'
                        ? '分子式纹理与金线的强度'
                        : '云母表面的颗粒质感'
                  }
                  min={0}
                  max={100}
                  suffix=""
                  onChange={(grain) => updateGlass({ grain })}
                />
              )}
              {(glass.material === 'liquid' || glass.material === 'shine') && (
                <>
                  <RangeRow
                    name="按钮与开关折射"
                    value={glass.refraction}
                    hint="小按钮、开关边缘像透镜一样扭曲背景的程度；0 为关闭"
                    min={0}
                    max={200}
                    suffix=" %"
                    onChange={(refraction) => updateGlass({ refraction })}
                  />
                  <RangeRow
                    name="卡片与弹窗折射"
                    value={glass.panelRefraction}
                    hint="卡片、弹窗等大面板边缘像透镜一样扭曲背景的程度；0 为关闭"
                    min={0}
                    max={200}
                    suffix=" %"
                    onChange={(panelRefraction) => updateGlass({ panelRefraction })}
                  />
                  <RangeRow
                    name="边缘宽度"
                    value={glass.edgeWidth}
                    hint="折射从边缘向内延伸的宽度"
                    min={4}
                    max={100}
                    suffix=" px"
                    onChange={(edgeWidth) => updateGlass({ edgeWidth })}
                  />
                  <RangeRow
                    name="边缘彩光"
                    value={glass.dispersion}
                    min={0}
                    max={100}
                    suffix=""
                    hint="边缘彩虹分光的强度"
                    onChange={(dispersion) => updateGlass({ dispersion })}
                  />
                </>
              )}
              {glass.material === 'shine' && (
                <>
                  <RangeRow
                    name="高光强度"
                    value={glass.highlight}
                    min={0}
                    max={100}
                    suffix=" %"
                    hint="边缘反光的明显程度"
                    onChange={(highlight) => updateGlass({ highlight })}
                  />
                  <RangeRow
                    name="高光角度"
                    value={glass.highlightAngle}
                    min={0}
                    max={360}
                    suffix="°"
                    hint="光源方向，决定高光出现在哪一侧"
                    onChange={(highlightAngle) => updateGlass({ highlightAngle })}
                  />
                </>
              )}
              </Collapse>
              <div className="settings-group-title">危险操作</div>
              <Row
                name="移除应用"
                desc="仅从启动器中移除，磁盘上的文件和游戏数据不会被删除"
                action={
                  <button className="btn sm danger" onClick={onRemove}>
                    从启动器移除
                  </button>
                }
              />
            </div>
          ) : (
            <div className="settings">
              <div className="settings-group-title">外观</div>
              <IconPicker
                src={launcher.iconFile ? (brandUrl(launcher.iconFile) ?? '') : defaultIconUrl()}
                label="启动器图标"
                desc="支持图片，或从 exe / bat / lnk 提取图标；选好后可拖动、缩放并截取方形区域。"
                onPick={onPickLauncherIcon}
                onClear={launcher.iconFile ? onClearLauncherIcon : undefined}
              />
              <Collapse
                open={themeOpen}
                header={
                  <Row
                    name="主题"
                    desc={themeSummary}
                    action={
                      <button
                        className={`btn sm ghost module-caret${themeOpen ? ' open' : ''}`}
                        title="逐项主题设置"
                        aria-label="逐项主题设置"
                        aria-expanded={themeOpen}
                        onClick={() => setThemeOpen((value) => !value)}
                      >
                        <Icon name="chevronDown" size={16} />
                      </button>
                    }
                  />
                }
              >
                <Row
                  name="批量设置"
                  desc="把所选主题应用到全部区域"
                  action={
                    <div className="media-row" style={{ gap: 8 }}>
                      <Select
                        value={bulkTheme}
                        onChange={(value) => setBulkTheme(value as SpecialThemeId)}
                        options={SPECIAL_THEMES.map((theme) => ({
                          value: theme.id,
                          label: theme.label
                        }))}
                      />
                      <button
                        className="btn sm"
                        onClick={() => {
                          onSetBehavior({ themeAreas: withAllThemes(launcher.themeAreas, bulkTheme) })
                        }}
                      >
                        应用到全部
                      </button>
                      <button
                        className="btn sm ghost"
                        onClick={() => {
                          onSetBehavior({ themeAreas: withAllThemes({}, 'default') })
                          setBulkTheme(null)
                        }}
                      >
                        恢复默认
                      </button>
                    </div>
                  }
                />
                {SPECIAL_AREA_GROUPS.map((group) => (
                  <div className="theme-group" key={group}>
                    <div className="settings-group-title">{group}</div>
                    {SPECIAL_AREAS.filter((area) => area.group === group).map((area) => (
                      <Row
                        key={area.id}
                        name={area.label}
                        desc={area.hint}
                        action={
                          <Select
                            value={launcher.themeAreas[area.id] ?? 'default'}
                            onChange={(value) =>
                              onSetBehavior({
                                themeAreas: withAreaTheme(
                                  launcher.themeAreas,
                                  area.id,
                                  value as SpecialThemeId
                                )
                              })
                            }
                            options={SPECIAL_THEMES.map((theme) => ({
                              value: theme.id,
                              label: theme.label
                            }))}
                          />
                        }
                      />
                    ))}
                  </div>
                ))}
              </Collapse>

              <AppearancePresetsSection disabled={savingGlass} />

              {([
                {
                  script: 'en' as const,
                  name: '英文字体',
                  hint: '英文、数字与半角符号',
                  value: launcher.fontFamilyEn
                },
                {
                  script: 'zh' as const,
                  name: '中文字体',
                  hint: '中文与全角标点',
                  value: launcher.fontFamilyZh
                }
              ]).map(({ script, name, hint, value }) => (
                <Fragment key={script}>
                  <Collapse
                    open={fontTarget === script}
                    header={
                      <Row
                        name={name}
                        desc={`${hint} · ${value ?? '默认（跟随系统）'}`}
                        action={
                          <div className="media-row" style={{ gap: 8 }}>
                            {value !== null && (
                              <button
                                className="btn sm ghost"
                                onClick={() => onSetLauncherFont(script, null)}
                              >
                                恢复默认
                              </button>
                            )}
                            <button
                              className="btn sm"
                              aria-expanded={fontTarget === script}
                              onClick={() =>
                                setFontTarget((current) => current === script ? null : script)
                              }
                            >
                              {fontTarget === script ? '收起' : '选择字体'}
                            </button>
                          </div>
                        }
                      />
                    }
                  >
                    {/* Mount the large list only for the one open picker. */}
                    {fontTarget === script && (
                      <div className="font-list">
                        {fonts.length === 0 ? (
                          <div className="font-empty">正在读取本机字体…</div>
                        ) : (
                          fonts.map((font) => (
                            <FontItem
                              key={font}
                              name={font}
                              active={value === font}
                              onPick={() => {
                                onSetLauncherFont(script, font)
                                setFontTarget(null)
                              }}
                            />
                          ))
                        )}
                      </div>
                    )}
                  </Collapse>
                </Fragment>
              ))}

              <Row
                name="侧边栏材质"
                desc={
                  launcher.sidebarMaterial
                    ? '侧边栏使用当前应用的玻璃材质与亮度'
                    : '侧边栏使用主题色纯色背景'
                }
                action={
                  <Switch
                    checked={launcher.sidebarMaterial}
                    label="启用"
                    title="侧边栏是否使用当前应用的玻璃材质"
                    onChange={(value) => onSetBehavior({ sidebarMaterial: value })}
                  />
                }
              />

              <div className="settings-group-title">启动行为</div>
              <Row
                name="点击窗口关闭按钮（×）"
                desc={
                  launcher.closeAction === 'tray'
                    ? '隐藏到系统托盘，点击托盘图标可重新打开'
                    : '退出启动器'
                }
                action={
                  <Segmented
                    value={launcher.closeAction}
                    onChange={(value) => onSetBehavior({ closeAction: value as CloseAction })}
                    options={[
                      { value: 'close', label: '退出启动器' },
                      { value: 'tray', label: '隐藏到托盘' }
                    ]}
                  />
                }
              />

              <Row
                name="启动应用后"
                desc={afterLaunchDesc[launcher.afterLaunch]}
                action={
                  <Segmented
                    value={launcher.afterLaunch}
                    onChange={(value) => onSetBehavior({ afterLaunch: value as AfterLaunchAction })}
                    options={[
                      { value: 'none', label: '无操作' },
                      { value: 'minimize', label: '最小化' },
                      { value: 'tray', label: '隐藏到托盘' },
                      { value: 'close', label: '关闭窗口' }
                    ]}
                  />
                }
              />

              <Row
                name="开机自启"
                desc={autoStartDesc[launcher.autoStart]}
                action={
                  <Segmented
                    value={launcher.autoStart}
                    onChange={(value) => onSetBehavior({ autoStart: value as AutoStartMode })}
                    options={[
                      { value: 'off', label: '关闭' },
                      { value: 'window', label: '打开窗口' },
                      { value: 'tray', label: '托盘启动' }
                    ]}
                  />
                }
              />

              <div className="settings-group-title">数据</div>
              <Row
                name="备份与恢复"
                desc="备份或恢复应用、启动器设置、使用时长、抽卡记录、图标与壁纸；不含游戏本体、缓存和日志"
                action={
                  <div className="media-row" style={{ gap: 8 }}>
                    <button className="btn sm" onClick={onExportData}>
                      导出备份
                    </button>
                    <button className="btn sm" onClick={onImportData}>
                      导入备份
                    </button>
                  </div>
                }
              />

              <Row
                name="数据目录"
                desc={dataDir ? `当前位置：${dataDir}` : '正在读取…'}
                action={
                  <button className="btn sm" onClick={onChangeDataDir}>
                    迁移…
                  </button>
                }
              />

              <div className="settings-section">
                <div className="settings-section-title">存储与清理</div>
                {([
                  ['旧版本更新残留', 'staleStaging'],
                  ['未完成更新（保留续传）', 'retainedStaging'],
                  ['图库缩略图（内存）', 'thumbnailMemory'],
                  ['图库缩略图（磁盘）', 'legacyThumbs'],
                  ['壁纸处理缓存（内存）', 'wallpaperMemory'],
                  ['壁纸处理缓存（磁盘）', 'wallpaperDisk'],
                  ['启动器日志', 'logs'],
                  ['游戏更新缓存', 'gameCache'],
                  ['壁纸与图标文件', 'media'],
                  ['更新备份与恢复文件', 'recovery']
                ] as const).map(([label, field]) => (
                  <div className="about-line" key={field}>
                    <span className="about-key">{label}</span>
                    <span className="usage-value">{usage?.[field] == null ? '—' : formatBytes(usage[field])}</span>
                  </div>
                ))}
                <p className="hint">
                  全部清理会删除旧版本更新残留、图库缩略图、壁纸处理缓存和日志；正在使用的壁纸与图标不会删除。
                </p>
                <div className="media-row" style={{ gap: 8, marginTop: 12 }}>
                  <button className="btn sm" disabled={cleaningUsage} onClick={() => onCleanUsage(['staging'])}>
                    清理更新残留
                  </button>
                  <button className="btn sm" disabled={cleaningUsage} onClick={() => onCleanUsage(['thumbs'])}>
                    清理缩略图
                  </button>
                  <button className="btn sm" disabled={cleaningUsage} onClick={() => onCleanUsage(['wallpaper'])}>
                    清理壁纸缓存
                  </button>
                  <button className="btn sm" disabled={cleaningUsage} onClick={() => onCleanUsage(['logs'])}>
                    清理日志
                  </button>
                  <button
                    className="btn sm ghost"
                    disabled={cleaningUsage}
                    onClick={() => onCleanUsage(['staging', 'thumbs', 'wallpaper', 'logs'])}
                  >
                    全部清理
                  </button>
                </div>
              </div>

              <div className="settings-group-title">更新与帮助</div>
              <Row
                name="检查更新"
                desc={updateCheckText || (trialBuild ? '检查本地测试版更新' : '检查是否有新的启动器版本')}
                action={
                  <button className="btn sm" disabled={checkingUpdate} onClick={onCheckUpdate}>
                    {checkingUpdate ? '检查中…' : '检查更新'}
                  </button>
                }
              />

              <Row name="当前版本" desc={version} />
              <Row
                name="更新通道"
                desc={
                  launcher.updateChannel === 'beta'
                    ? '接收新的 Beta 和更高的正式版，按版本号取最高；切回正式版不会回退已安装的版本。'
                    : '只接收版本号更高的正式版；从测试版切回不会回退已安装的版本。'
                }
                action={
                  <Segmented
                    value={launcher.updateChannel}
                    onChange={(value) => onSetBehavior({ updateChannel: value as UpdateChannel })}
                    options={[
                      { value: 'stable', label: '正式版' },
                      { value: 'beta', label: '测试版' }
                    ]}
                  />
                }
              />

              <Row
                name="下载限速"
                desc={
                  launcher.downloadLimitMbps > 0
                    ? `游戏更新、预下载和启动器更新共用 ${launcher.downloadLimitMbps} MB/s 的上限`
                    : '设置游戏更新、预下载和启动器更新的下载速度上限（MB/s）；填 0 表示不限速'
                }
                action={
                  <InlineEdit
                    className="wide"
                    value={String(launcher.downloadLimitMbps)}
                    placeholder="0（不限速）"
                    onCommit={(v) =>
                      onSetBehavior({
                        downloadLimitMbps: Math.max(0, Math.min(10240, parseInt(v, 10) || 0))
                      })
                    }
                  />
                }
              />
              <Row
                name="导出日志"
                desc="把运行日志复制到你选择的目录，便于反馈问题"
                action={
                  <button className="btn sm" onClick={onExportLogs}>
                    导出日志
                  </button>
                }
              />

              <div className="settings-section">
                <div className="settings-section-title">关于 · 开源与致谢</div>

                <div className="about-line">
                  <span className="about-key">项目仓库</span>
                  <button
                    className="about-link"
                    onClick={() => void window.api.openExternal(REPO_URL)}
                  >
                    {REPO_URL}
                  </button>
                </div>

                <div className="about-line column">
                  <span className="about-key">使用的第三方库</span>
                  <div className="about-deps">
                    {USED_LIBRARIES.map((dep) => (
                      <div className="about-dep" key={dep.name}>
                        <span>{dep.name}</span>
                        <em>{dep.note}</em>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="about-line column">
                  <span className="about-key">参考的第三方项目</span>
                  <div className="about-deps">
                    {REFERENCED_PROJECTS.map((project) => (
                      <div className="about-dep" key={project.name}>
                        <span>{project.name}</span>
                        <em>{project.note}</em>
                        <button
                          className="about-link"
                          title={project.url}
                          onClick={() => void window.api.openExternal(project.url)}
                        >
                          {project.url.replace(/^https?:\/\//, '')}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <p className="about-disclaimer">
                  本项目为非官方第三方启动器，与 miHoYo / HoYoverse / Hypergryph
                  及其关联公司无任何关系；所有游戏名称、图标与素材归各自权利人所有。使用本工具可能违反游戏用户协议，请自行承担风险。
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
