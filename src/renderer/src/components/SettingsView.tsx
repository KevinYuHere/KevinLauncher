import { useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import type {
  AfterLaunchAction,
  AppEntry,
  AutoStartMode,
  CloseAction,
  LauncherSettings,
  UsageReport
} from '@shared/types'
import { formatBytes } from '../format'
import { brandUrl, defaultIconUrl } from '../media'

/** Project repository (shown in the "About" section). */
const REPO_URL = 'https://github.com/KevinYuHere/KevinLauncher'

/** Third-party libraries this launcher actually uses at runtime / build time. */
const USED_LIBRARIES: { name: string; note: string }[] = [
  { name: 'Electron 33', note: 'MIT · 应用运行时（主进程 / 渲染进程 / 预加载）' },
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

// Settings page with two tabs that slide on the card itself (so the frosted
// glass behind stays put): per-app appearance/background, and launcher-wide
// icon/font/behavior/backup. All values are controlled by App.tsx.
interface SettingsViewProps {
  entry: AppEntry
  onBack: () => void
  onEdit: () => void
  onPickBackground: () => void
  onRemove: () => void
  bgBlur: number
  bgDim: number
  onBgTuning: (blur: number, dim: number) => void
  onResetBackground: () => void
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

function Seg({
  value,
  current,
  onPick,
  children
}: {
  value: string
  current: string
  onPick: (value: string) => void
  children: ReactNode
}): ReactElement {
  return (
    <button className={`seg${current === value ? ' active' : ''}`} onClick={() => onPick(value)}>
      {children}
    </button>
  )
}

function RangeRow({
  name,
  value,
  min,
  max,
  suffix,
  onChange
}: {
  name: string
  value: number
  min: number
  max: number
  suffix: string
  onChange: (value: number) => void
}): ReactElement {
  return (
    <Row
      name={name}
      desc={`${value}${suffix}`}
      action={
        <input
          className="slider"
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
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
  onBack,
  onEdit,
  onPickBackground,
  onRemove,
  bgBlur,
  bgDim,
  onBgTuning,
  onResetBackground,
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
  updateCheckText
}: SettingsViewProps): ReactElement {
  const [tab, setTab] = useState<'game' | 'launcher'>('game')
  const [dir, setDir] = useState(1)
  const autoTheme = entry.autoTheme ?? true

  const switchTab = (next: 'game' | 'launcher'): void => {
    if (next === tab) return
    setDir(next === 'launcher' ? 1 : -1)
    setTab(next)
  }

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
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-subtitle">{tab === 'game' ? `应用 · ${entry.name}` : '启动器本体'}</p>
        </div>
        <div className="page-actions">
          {tab === 'game' && (
            <button className="btn primary" onClick={onEdit}>
              编辑应用
            </button>
          )}
          <button className="btn ghost" onClick={onBack}>
            返回主页
          </button>
        </div>
      </div>

      <div className="page-body">
        <div className="tabs">
          <button className={`tab${tab === 'game' ? ' active' : ''}`} onClick={() => switchTab('game')}>
            应用设置
          </button>
          <button
            className={`tab${tab === 'launcher' ? ' active' : ''}`}
            onClick={() => switchTab('launcher')}
          >
            启动器设置
          </button>
        </div>

        <div
          key={tab}
          className="tab-panel"
          style={{ '--tab-x': `${dir * 22}px` } as CSSProperties}
        >
          {tab === 'game' ? (
            <div className="settings">
              <Row
                name="背景"
                desc={entry.backgroundFile ? '已设置自定义背景' : '默认（桌面壁纸）'}
                action={
                  <div className="media-row" style={{ gap: 8 }}>
                    <button className="btn sm" onClick={onPickBackground}>
                      更换背景
                    </button>
                    <button className="btn sm ghost" onClick={onResetBackground}>
                      恢复默认
                    </button>
                  </div>
                }
              />
              <Row
                name="主题色"
                desc={autoTheme ? '自动从背景提取' : (entry.themeColor ?? '默认（品牌蓝）')}
                action={
                  <div className="media-row" style={{ gap: 8 }}>
                    <label className="switch" title="自动从背景提取主题色">
                      <input
                        type="checkbox"
                        checked={autoTheme}
                        onChange={(e) => void window.api.setAutoTheme(entry.id, e.target.checked)}
                      />
                      <span>自动</span>
                    </label>
                    {!autoTheme && (
                      <>
                        <input
                          className="color-input"
                          type="color"
                          value={entry.themeColor ?? '#3778e5'}
                          onChange={(e) => void window.api.setThemeColor(entry.id, e.target.value)}
                          title="选择主题色"
                        />
                        <button
                          className="btn sm"
                          disabled={!entry.backgroundFile}
                          onClick={() => void window.api.extractThemeColor(entry.id)}
                          title={entry.backgroundFile ? '从背景图提取主题色' : '请先设置背景'}
                        >
                          从背景提取
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
              <Row
                name="界面玻璃风格"
                desc={
                  (entry.glassStyle ?? 'dark') === 'light' ? '亮色玻璃：清爽通透' : '暗色玻璃：沉稳内敛'
                }
                action={
                  <div className="segmented">
                    <Seg value="dark" current={entry.glassStyle ?? 'dark'} onPick={() => void window.api.setGlassStyle(entry.id, 'dark')}>
                      暗色
                    </Seg>
                    <Seg value="light" current={entry.glassStyle ?? 'dark'} onPick={() => void window.api.setGlassStyle(entry.id, 'light')}>
                      亮色
                    </Seg>
                  </div>
                }
              />
              <RangeRow
                name="背景模糊"
                value={bgBlur}
                min={0}
                max={40}
                suffix=" px"
                onChange={(blur) => onBgTuning(blur, bgDim)}
              />
              <RangeRow
                name="背景压暗"
                value={bgDim}
                min={0}
                max={100}
                suffix=" %"
                onChange={(dim) => onBgTuning(bgBlur, dim)}
              />
              <Row
                name="移除应用"
                desc="从启动器中删除该应用，不会删除磁盘上的文件"
                action={
                  <button className="btn sm danger" onClick={onRemove}>
                    移除
                  </button>
                }
              />
            </div>
          ) : (
            <div className="settings">
              <div className="launcher-brand">
              <button
                className="launcher-icon has-image"
                onClick={onPickLauncherIcon}
                title="点击更换启动器图标"
              >
                <img
                  src={launcher.iconFile ? (brandUrl(launcher.iconFile) ?? '') : defaultIconUrl()}
                  alt=""
                />
              </button>
                <div className="launcher-brand-side">
                  <div className="settings-name">启动器图标</div>
                  <div className="settings-desc">
                    支持图片，或选择 exe / bat / lnk 提取其图标；选后可框选正方形并缩放。
                  </div>
                  <div className="media-row" style={{ gap: 8, marginTop: 10 }}>
                    <button className="btn sm primary" onClick={onPickLauncherIcon}>
                      更换图标
                    </button>
                    {launcher.iconFile && (
                      <button className="btn sm ghost" onClick={onClearLauncherIcon}>
                        恢复默认
                      </button>
                    )}
                  </div>
                </div>
              </div>

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
                name="点击关闭按钮（×）"
                desc={
                  launcher.closeAction === 'tray' ? '隐藏到托盘（点托盘图标可重新打开）' : '关闭启动器'
                }
                action={
                  <div className="segmented">
                    <Seg
                      value="close"
                      current={launcher.closeAction}
                      onPick={(v) => onSetBehavior({ closeAction: v as CloseAction })}
                    >
                      关闭启动器
                    </Seg>
                    <Seg
                      value="tray"
                      current={launcher.closeAction}
                      onPick={(v) => onSetBehavior({ closeAction: v as CloseAction })}
                    >
                      隐藏到托盘
                    </Seg>
                  </div>
                }
              />

              <Row
                name="启动应用后"
                desc={afterLaunchDesc[launcher.afterLaunch]}
                action={
                  <div className="segmented">
                    <Seg
                      value="none"
                      current={launcher.afterLaunch}
                      onPick={(v) => onSetBehavior({ afterLaunch: v as AfterLaunchAction })}
                    >
                      无操作
                    </Seg>
                    <Seg
                      value="minimize"
                      current={launcher.afterLaunch}
                      onPick={(v) => onSetBehavior({ afterLaunch: v as AfterLaunchAction })}
                    >
                      最小化
                    </Seg>
                    <Seg
                      value="tray"
                      current={launcher.afterLaunch}
                      onPick={(v) => onSetBehavior({ afterLaunch: v as AfterLaunchAction })}
                    >
                      隐藏到托盘
                    </Seg>
                    <Seg
                      value="close"
                      current={launcher.afterLaunch}
                      onPick={(v) => onSetBehavior({ afterLaunch: v as AfterLaunchAction })}
                    >
                      关闭启动器
                    </Seg>
                  </div>
                }
              />

              <Row
                name="开机自启"
                desc={autoStartDesc[launcher.autoStart]}
                action={
                  <div className="segmented">
                    <Seg
                      value="off"
                      current={launcher.autoStart}
                      onPick={(v) => onSetBehavior({ autoStart: v as AutoStartMode })}
                    >
                      关闭
                    </Seg>
                    <Seg
                      value="window"
                      current={launcher.autoStart}
                      onPick={(v) => onSetBehavior({ autoStart: v as AutoStartMode })}
                    >
                      打开窗口
                    </Seg>
                    <Seg
                      value="tray"
                      current={launcher.autoStart}
                      onPick={(v) => onSetBehavior({ autoStart: v as AutoStartMode })}
                    >
                      静默托盘
                    </Seg>
                  </div>
                }
              />

              <Row
                name="备份与恢复"
                desc="导出 / 导入全部设置（应用、使用时长、抽卡记录、图标、背景）"
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
                name="检查更新"
                desc={updateCheckText || '检查 GitHub Releases 上是否有新版本'}
                action={
                  <button className="btn sm" disabled={checkingUpdate} onClick={onCheckUpdate}>
                    {checkingUpdate ? '检查中…' : '检查更新'}
                  </button>
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

              <Row name="当前版本" desc={version} />

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
