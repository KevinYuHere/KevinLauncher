import {
  useCallback,
  useEffect,
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
  AutoStartMode,
  CloseAction,
  UpdateChannel,
  GlassAppearance,
  GlassMaterial,
  GlassPatch,
  LauncherSettings,
  UsageReport
} from '@shared/types'
import { DEFAULT_GLASS_APPEARANCE, MATERIAL_DEFAULTS } from '@shared/types'
import { currentWallpaper, isVideoFile } from '@shared/appEntry'
import { formatBytes } from '../format'
import { brandUrl, defaultIconUrl, iconUrl } from '../media'
import { applyGlass } from '../theme'
import ColorPicker from './ColorPicker'
import Collapse from './Collapse'
import IconPicker from './IconPicker'
import InlineEdit from './InlineEdit'
import GlassPopup from './GlassPopup'
import Icon from './Icon'
import Segmented from './Segmented'
import Select from './Select'
import Switch from './Switch'

/** Project repository (shown in the "About" section). */
const REPO_URL = 'https://github.com/KevinYuHere/KevinLauncher'

/** Third-party libraries this launcher actually uses at runtime / build time. */
const USED_LIBRARIES: { name: string; note: string }[] = [
  { name: 'Electron 44', note: 'MIT · 应用运行时（主进程 / 渲染进程 / 预加载）' },
  { name: 'React 18 + ReactDOM', note: 'MIT · 界面渲染' },
  { name: 'fzstd', note: 'MIT · zstd 解压（Sophon 清单与资源块）' },
  { name: '@electron-toolkit/preload、@electron-toolkit/utils', note: 'MIT · 预加载桥与工具函数' },
  { name: 'HDiffPatch（hpatchz.exe）', note: 'MIT · 差分补丁应用（增量更新）' },
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
    note: 'MIT · 增量更新思路与 hpatchz 可执行文件来源',
    url: 'https://github.com/sisong/HDiffPatch'
  }
]

/** Short label + description for each glass material. */
const GLASS_MATERIAL_LABEL: Record<GlassMaterial, string> = {
  blur: '毛玻璃',
  mica: '云母',
  liquid: '液态',
  shine: '高光'
}

const GLASS_MATERIAL_DESC: Record<GlassMaterial, string> = {
  blur: '毛玻璃：经典磨砂质感',
  mica: '云母：更致密的磨砂质感',
  liquid: '液态玻璃：外轮廓膨胀折射',
  shine: '高光：液态玻璃 + 随环境着色的边缘高光'
}

// Settings page with two tabs that slide on the card itself (so the frosted
// glass behind stays put): per-app appearance/background, and launcher-wide
// icon/font/behavior/backup. All values are controlled by App.tsx.
interface SettingsViewProps {
  entry: AppEntry
  addons: AddonDescriptor[]
  onBack: () => void
  /** Merge a partial change into the app (name / addon / dirs / monitors …). */
  onPatchEntry: (patch: Partial<AppEntry>) => void
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
  onSetFont: (family: string | null) => void
  onSetBehavior: (patch: {
    closeAction?: CloseAction
    afterLaunch?: AfterLaunchAction
    autoStart?: AutoStartMode
    sidebarMaterial?: boolean
    updateChannel?: UpdateChannel
  }) => void
  onExportData: () => void
  onImportData: () => void
  /** Current data directory (config, playtime, gacha, icons …). */
  dataDir: string
  onChangeDataDir: () => void
  /** Disk usage of the cleanable caches. */
  usage: UsageReport | null
  onCleanUsage: (kinds: ('staging' | 'thumbs' | 'logs')[]) => void
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
  onSetFont,
  onSetBehavior,
  onExportData,
  onImportData,
  dataDir,
  onChangeDataDir,
  usage,
  onCleanUsage,
  onCheckUpdate,
  checkingUpdate,
  updateCheckText,
  onExportLogs
}: SettingsViewProps): ReactElement {
  const [tab, setTab] = useState<'game' | 'launcher'>('game')
  const [dir, setDir] = useState(1)
  const [showColor, setShowColor] = useState(false)
  const [glassOpen, setGlassOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const autoTheme = entry.autoTheme ?? true
  const currentIcon = iconUrl(entry.iconFile)
  const wallpaper = currentWallpaper(entry)
  const canExtractTheme = !!wallpaper && !isVideoFile(wallpaper.file)

  const pickDir = async (kind: 'game' | 'shot'): Promise<void> => {
    const path = await window.api.pickDirectory()
    if (!path) return
    onPatchEntry(kind === 'game' ? { gameDirectory: path } : { screenshotDirectory: path })
  }
  // Live glass editing: apply immediately (so dragging feels instant) and
  // persist once the user stops (debounced), without re-rendering the whole app.
  const [glass, setGlass] = useState<GlassAppearance>(entry.glass ?? DEFAULT_GLASS_APPEARANCE)
  const glassRef = useRef<GlassAppearance>(entry.glass ?? DEFAULT_GLASS_APPEARANCE)
  const glassTimer = useRef<number | undefined>(undefined)
  const glassRaf = useRef(0)

  useEffect(() => {
    const next = entry.glass ?? DEFAULT_GLASS_APPEARANCE
    glassRef.current = next
    setGlass(next)
  }, [entry.id])

  const updateGlass = useCallback(
    (patch: GlassPatch): void => {
      // Switching material loads that material's recommended parameters.
      const next =
        patch.material && patch.material !== glassRef.current.material
          ? { ...MATERIAL_DEFAULTS[patch.material] }
          : { ...DEFAULT_GLASS_APPEARANCE, ...glassRef.current, ...patch }
      glassRef.current = next
      setGlass(next)
      // Coalesce the (heavier) live preview to one per frame so dragging the
      // sliders stays smooth.
      if (!glassRaf.current) {
        glassRaf.current = requestAnimationFrame(() => {
          glassRaf.current = 0
          applyGlass(glassRef.current)
        })
      }
      if (glassTimer.current) window.clearTimeout(glassTimer.current)
      const id = entry.id
      glassTimer.current = window.setTimeout(() => {
        void window.api.setGlass(id, glassRef.current)
      }, 200)
    },
    [entry.id]
  )

  const tabPanelRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const colorBtnRef = useRef<HTMLButtonElement>(null)
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
    none: '无操作（启动器保持现状）',
    minimize: '最小化启动器',
    tray: '隐藏启动器到托盘',
    close: '关闭启动器'
  }

  const autoStartDesc: Record<AutoStartMode, string> = {
    off: '不随 Windows 启动',
    window: '登录 Windows 后自动打开启动器窗口',
    tray: '登录后静默启动到托盘（不显示窗口）'
  }

  return (
    <div className="page" ref={pageRef}>
      <div className="page-header">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-subtitle">{tab === 'game' ? `应用 · ${entry.name}` : '启动器本体'}</p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={onBack}>
            返回主页
          </button>
        </div>
      </div>

      <div className="page-body">
        <Segmented
          variant="tab"
          value={tab}
          onChange={(value) => switchTab(value as 'game' | 'launcher')}
          options={[
            { value: 'game', label: '应用设置' },
            { value: 'launcher', label: '启动器设置' }
          ]}
        />

        <div
          ref={tabPanelRef}
          className="tab-panel"
          style={{ '--tab-x': `${dir * 26}px` } as CSSProperties}
        >
          {tab === 'game' ? (
            <div className="settings">
              <div className="settings-group-title">基本信息</div>
              <IconPicker
                small
                src={currentIcon}
                label="应用图标"
                desc="可选图片，或选择 exe / bat / lnk 提取其图标；选后可框选正方形并缩放。"
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
                desc="启动文件、参数、工作目录、管理员运行与默认方式（在模块管理中设置）"
                action={
                  <button className="btn sm" onClick={() => onOpenModuleSettings('launch')}>
                    去设置
                  </button>
                }
              />
              <Row
                name="壁纸设置"
                desc="壁纸列表与轮换、模糊 / 压暗"
                action={
                  <button className="btn sm" onClick={() => onOpenModuleSettings('wallpaper')}>
                    去设置
                  </button>
                }
              />

              <Row
                name="高级设置"
                desc={advancedOpen ? '收起高级选项' : '游戏目录、截图目录、监视进程名'}
                action={
                  <button
                    className={`btn sm ghost module-caret${advancedOpen ? ' open' : ''}`}
                    title="展开 / 收起"
                    aria-expanded={advancedOpen}
                    onClick={() => setAdvancedOpen((v) => !v)}
                  >
                    <Icon name="chevronDown" size={16} />
                  </button>
                }
              />
              <Collapse open={advancedOpen}>
                  {entry.addonId != null && (
                    <Row
                      name="游戏目录"
                      desc={entry.gameDirectory ?? '未设置（版本检测 / 更新 / 抽卡缓存需要）'}
                      action={
                        <div className="media-row" style={{ gap: 8 }}>
                          <button className="btn sm" onClick={() => void pickDir('game')}>
                            选择…
                          </button>
                          {entry.gameDirectory && (
                            <button
                              className="btn sm ghost"
                              onClick={() => onPatchEntry({ gameDirectory: null })}
                            >
                              清除
                            </button>
                          )}
                        </div>
                      }
                    />
                  )}
                  <Row
                    name="截图目录"
                    desc={entry.screenshotDirectory ?? '未设置（用于图库）'}
                    action={
                      <div className="media-row" style={{ gap: 8 }}>
                        <button className="btn sm" onClick={() => void pickDir('shot')}>
                          选择…
                        </button>
                        {entry.screenshotDirectory && (
                          <button
                            className="btn sm ghost"
                            onClick={() => onPatchEntry({ screenshotDirectory: null })}
                          >
                            清除
                          </button>
                        )}
                      </div>
                    }
                  />
                  <Row
                    name="监视进程名"
                    desc="快捷方式 / 提权启动等无法按 PID 追踪时的运行检测与时长统计"
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
              <Row
                name="主题色"
                desc={autoTheme ? '自动从当前壁纸提取' : (entry.themeColor ?? '默认（品牌蓝）')}
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
                          ref={colorBtnRef}
                          type="button"
                          className="color-trigger"
                          title="自定义主题色"
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
                          title={canExtractTheme ? '从当前壁纸提取主题色' : '当前壁纸无法提取（视频或未设置）'}
                        >
                          从当前壁纸提取
                        </button>
                        <button
                          className="btn sm ghost"
                          onClick={() => void window.api.setThemeColor(entry.id, null)}
                        >
                          重置
                        </button>
                      </>
                    )}
                  </div>
                }
              />
              {!autoTheme && (
                <GlassPopup
                  anchorRef={colorBtnRef}
                  boundsRef={pageRef}
                  visible={showColor}
                  className="color-popup"
                  onDismiss={() => setShowColor(false)}
                >
                  <ColorPicker
                    value={entry.themeColor}
                    onChange={(hex) => void window.api.setThemeColor(entry.id, hex)}
                  />
                </GlassPopup>
              )}
              <Row
                name="玻璃材质"
                desc={GLASS_MATERIAL_DESC[glass.material]}
                action={
                  <div className="media-row" style={{ gap: 8 }}>
                    <Segmented
                      value={glass.material}
                      onChange={(value) => updateGlass({ material: value as GlassMaterial })}
                      options={(['blur', 'mica', 'liquid', 'shine'] as GlassMaterial[]).map(
                        (material) => ({ value: material, label: GLASS_MATERIAL_LABEL[material] })
                      )}
                    />
                    <button
                      className={`btn sm ghost module-caret${glassOpen ? ' open' : ''}`}
                      title="材质细节参数"
                      aria-expanded={glassOpen}
                      onClick={() => setGlassOpen((v) => !v)}
                    >
                      <Icon name="chevronDown" size={16} />
                    </button>
                    <button
                      className="btn sm ghost"
                      title="把当前材质的各项参数恢复为推荐默认值"
                      onClick={() => updateGlass({ ...MATERIAL_DEFAULTS[glass.material] })}
                    >
                      重置
                    </button>
                  </div>
                }
              />
              <Collapse open={glassOpen}>
              <RangeRow
                name="玻璃亮度"
                value={glass.brightness}
                hint="玻璃底色：0 偏黑，100 偏白"
                min={0}
                max={100}
                suffix=""
                onChange={(brightness) => updateGlass({ brightness })}
              />
              <RangeRow
                name="玻璃透明度"
                value={glass.opacity}
                hint="底色的透明程度：100 完全不叠加底色（清透）"
                min={0}
                max={100}
                suffix=" %"
                onChange={(opacity) => updateGlass({ opacity })}
              />
              <RangeRow
                name="玻璃模糊"
                value={glass.blur}
                hint="玻璃磨砂的模糊半径"
                min={0}
                max={60}
                suffix=" px"
                onChange={(blur) => updateGlass({ blur })}
              />
              {(glass.material === 'blur' || glass.material === 'mica') && (
                <RangeRow
                  name="背景饱和度"
                  value={glass.saturation}
                  hint="背景色彩的浓淡（毛玻璃 / 云母）"
                  min={50}
                  max={200}
                  suffix=" %"
                  onChange={(saturation) => updateGlass({ saturation })}
                />
              )}
              {glass.material === 'mica' && (
                <RangeRow
                  name="颗粒"
                  value={glass.grain}
                  hint="云母表面的颗粒质感"
                  min={0}
                  max={100}
                  suffix=""
                  onChange={(grain) => updateGlass({ grain })}
                />
              )}
              {(glass.material === 'liquid' || glass.material === 'shine') && (
                <>
                  <RangeRow
                    name="折射强度（控件）"
                    value={glass.refraction}
                    hint="按钮/小控件的边缘折射强度"
                    min={0}
                    max={200}
                    suffix=" %"
                    onChange={(refraction) => updateGlass({ refraction })}
                  />
                  <RangeRow
                    name="折射强度（面板）"
                    value={glass.panelRefraction}
                    hint="卡片/弹窗的边缘折射强度"
                    min={0}
                    max={200}
                    suffix=" %"
                    onChange={(panelRefraction) => updateGlass({ panelRefraction })}
                  />
                  <RangeRow
                    name="边缘宽度"
                    value={glass.edgeWidth}
                    hint="边缘折射扭曲的影响范围"
                    min={4}
                    max={100}
                    suffix=" px"
                    onChange={(edgeWidth) => updateGlass({ edgeWidth })}
                  />
                  <RangeRow
                    name="色散"
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
                    hint="边缘镜面高光的亮度"
                    onChange={(highlight) => updateGlass({ highlight })}
                  />
                  <RangeRow
                    name="高光角度"
                    value={glass.highlightAngle}
                    min={0}
                    max={360}
                    suffix="°"
                    hint="高光来自的方向"
                    onChange={(highlightAngle) => updateGlass({ highlightAngle })}
                  />
                </>
              )}
              </Collapse>
              <div className="settings-group-title">危险操作</div>
              <Row
                name="移除应用"
                desc="仅从启动器中移除，不会删除磁盘上的任何文件"
                action={
                  <button className="btn sm danger" onClick={onRemove}>
                    移除
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
                desc="支持图片，或选择 exe / bat / lnk 提取其图标；选后可框选正方形并缩放。"
                onPick={onPickLauncherIcon}
                onClear={launcher.iconFile ? onClearLauncherIcon : undefined}
              />

              <Row
                name="字体"
                desc={launcher.fontFamily ?? '默认（跟随系统）'}
                action={
                  launcher.fontFamily ? (
                    <button className="btn sm ghost" onClick={() => onSetFont(null)}>
                      恢复默认
                    </button>
                  ) : undefined
                }
              />
              <div className="font-list">
                {fonts.length === 0 ? (
                  <div className="font-empty">正在读取本机字体…</div>
                ) : (
                  fonts.map((font) => (
                    <FontItem
                      key={font}
                      name={font}
                      active={launcher.fontFamily === font}
                      onPick={() => onSetFont(font)}
                    />
                  ))
                )}
              </div>

              <Row
                name="侧边栏应用材质"
                desc={
                  launcher.sidebarMaterial
                    ? '侧边栏使用当前应用的玻璃材质'
                    : '侧边栏使用主题色'
                }
                action={
                  <Switch
                    checked={launcher.sidebarMaterial}
                    label="应用"
                    title="侧边栏是否应用当前应用的玻璃材质"
                    onChange={(value) => onSetBehavior({ sidebarMaterial: value })}
                  />
                }
              />

              <div className="settings-group-title">启动行为</div>
              <Row
                name="点击关闭按钮（×）"
                desc={
                  launcher.closeAction === 'tray' ? '隐藏到托盘（点托盘图标可重新打开）' : '关闭启动器'
                }
                action={
                  <Segmented
                    value={launcher.closeAction}
                    onChange={(value) => onSetBehavior({ closeAction: value as CloseAction })}
                    options={[
                      { value: 'close', label: '关闭启动器' },
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
                      { value: 'close', label: '关闭启动器' }
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
                      { value: 'tray', label: '静默托盘' }
                    ]}
                  />
                }
              />

              <div className="settings-group-title">数据</div>
              <Row
                name="备份与恢复"
                desc="导出 / 导入全部设置（应用、使用时长、抽卡记录、图标、壁纸）"
                action={
                  <div className="media-row" style={{ gap: 8 }}>
                    <button className="btn sm" onClick={onExportData}>
                      导出设置
                    </button>
                    <button className="btn sm" onClick={onImportData}>
                      导入设置
                    </button>
                  </div>
                }
              />

              <Row
                name="数据目录"
                desc={dataDir || '…'}
                action={
                  <button className="btn sm" onClick={onChangeDataDir}>
                    更改…
                  </button>
                }
              />

              <div className="settings-section">
                <div className="settings-section-title">清理与占用</div>
                <div className="about-line">
                  <span className="about-key">升级暂存</span>
                  <span className="usage-value">{formatBytes(usage?.staging ?? 0)}</span>
                </div>
                <div className="about-line">
                  <span className="about-key">缩略图缓存</span>
                  <span className="usage-value">{formatBytes(usage?.thumbs ?? 0)}</span>
                </div>
                <div className="about-line">
                  <span className="about-key">日志</span>
                  <span className="usage-value">{formatBytes(usage?.logs ?? 0)}</span>
                </div>
                <div className="media-row" style={{ gap: 8, marginTop: 12 }}>
                  <button className="btn sm" onClick={() => onCleanUsage(['staging'])}>
                    清理暂存
                  </button>
                  <button className="btn sm" onClick={() => onCleanUsage(['thumbs'])}>
                    清理缩略图
                  </button>
                  <button className="btn sm" onClick={() => onCleanUsage(['logs'])}>
                    清理日志
                  </button>
                  <button
                    className="btn sm ghost"
                    onClick={() => onCleanUsage(['staging', 'thumbs', 'logs'])}
                  >
                    全部清理
                  </button>
                </div>
              </div>

              <div className="settings-group-title">更新与帮助</div>
              <Row
                name="检查更新"
                desc={updateCheckText || '检查 GitHub Releases 上是否有新版本'}
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
                    ? '测试版：优先接收预发布版本'
                    : '正式版：仅接收稳定版本'
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
