import { useEffect, useRef, useState, type ReactElement } from 'react'
import {
  DEFAULT_HOME_MODULE,
  DEFAULT_WALLPAPER_SETTINGS,
  HOME_MODULES,
  type AppEntry,
  type HomeModuleId,
  type HomeModuleState,
  type LaunchEffect,
  type LaunchMethod,
  type LinkedLaunch,
  type WallpaperSettings
} from '@shared/types'
import { isVideoFile } from '@shared/appEntry'
import { backgroundUrl } from '../media'
import Switch from './Switch'
import Segmented from './Segmented'
import Icon from './Icon'
import Sortable, { type SortableHandle } from './Sortable'
import Checkbox from './Checkbox'
import Collapse from './Collapse'
import Select from './Select'
import InlineEdit from './InlineEdit'
import LaunchMethodsEditor from './LaunchMethodsEditor'

interface ModuleManagerViewProps {
  entry: AppEntry
  linkedLaunches: LinkedLaunch[]
  onBack: () => void
  onSetModule: (moduleId: HomeModuleId, patch: Partial<HomeModuleState>) => void
  onResetModulePosition: (moduleId: HomeModuleId) => void
  onSetModuleLabel: (label: string | null) => void
  onSetLaunchEffect: (effect: LaunchEffect) => void
  onSetLaunchMethods: (methods: LaunchMethod[], defaultId: string) => void
  onWallpaperAdd: () => void
  onWallpaperRemove: (id: string) => void
  onWallpaperReorder: (ids: string[]) => void
  onWallpaperSettings: (patch: Partial<WallpaperSettings>) => void
  onWallpaperSelect: (index: number) => void
  onWallpaperView: (index: number) => void
  onBgTuning: (blur: number, dim: number) => void
  onSetAppLinked: (ids: string[], defaultId: string | null) => void
  /** Jump to the linked-launch page with the given entry expanded. */
  onEditLinkedLaunch: (id: string) => void
  /** A settings section to open expanded (jumped to from app settings). */
  initialExpanded?: HomeModuleId | null
}

const HAS_SETTINGS: HomeModuleId[] = ['info', 'launch', 'wallpaper', 'linkedLaunch']

const TRIGGER_LABELS: { value: WallpaperSettings['trigger']; label: string }[] = [
  { value: 'launcherStart', label: '启动启动器' },
  { value: 'appSwitch', label: '切换应用时' },
  { value: 'appLaunch', label: '启动应用后' },
  { value: 'interval', label: '定时' }
]

function Row({
  name,
  desc,
  children
}: {
  name: string
  desc: string
  children: ReactElement
}): ReactElement {
  return (
    <div className="settings-row">
      <div className="settings-main">
        <div className="settings-name">{name}</div>
        <div className="settings-desc">{desc}</div>
      </div>
      <div className="settings-action">{children}</div>
    </div>
  )
}

/** Wallpaper list + rotation + shared blur/dim. */
function WallpaperPanel({
  entry,
  onAdd,
  onRemove,
  onReorder,
  onSettings,
  onSelect,
  onView,
  onBgTuning
}: {
  entry: AppEntry
  onAdd: () => void
  onRemove: (id: string) => void
  onReorder: (ids: string[]) => void
  onSettings: (patch: Partial<WallpaperSettings>) => void
  onSelect: (index: number) => void
  onView: (index: number) => void
  onBgTuning: (blur: number, dim: number) => void
}): ReactElement {
  const settings = { ...DEFAULT_WALLPAPER_SETTINGS, ...entry.wallpaperSettings }
  // Local blur/dim so the sliders track the pointer immediately (the persisted
  // value only round-trips after the debounced save).
  const [tuning, setTuning] = useState({ blur: entry.backgroundBlur, dim: entry.backgroundDim })
  useEffect(() => {
    setTuning({ blur: entry.backgroundBlur, dim: entry.backgroundDim })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id])
  const setTuningAnd = (blur: number, dim: number): void => {
    setTuning({ blur, dim })
    onBgTuning(blur, dim)
  }
  return (
    <div className="settings">
      <Row name="壁纸列表" desc={`共 ${entry.wallpapers.length} 张 · 拖动排序；点缩略图看大图，点名称切换到该张`}>
        <button className="btn sm" onClick={onAdd}>
          添加图片 / 视频
        </button>
      </Row>
      {entry.wallpapers.length === 0 ? (
        <div className="settings-empty">还没有壁纸，当前使用系统桌面壁纸。</div>
      ) : (
        <Sortable
          items={entry.wallpapers}
          getKey={(w) => w.id}
          onReorder={onReorder}
          renderItem={(wallpaper, index, handle) => (
            <div
              className={`wl-row${wallpaper.id === entry.wallpapers[entry.wallpaperIndex]?.id ? ' current' : ''}`}
            >
              <button
                className={`ll-grip${handle.dragging ? ' dragging' : ''}`}
                title="拖动排序"
                onPointerDown={handle.onPointerDown}
              >
                <Icon name="grip" size={16} />
              </button>
              <button className="wl-thumb-btn" title="查看大图" onClick={() => onView(index)}>
                {isVideoFile(wallpaper.file) ? (
                  <video
                    className="wl-thumb"
                    src={`${backgroundUrl(wallpaper.file)}#t=0.1`}
                    muted
                    preload="metadata"
                  />
                ) : (
                  <img className="wl-thumb" src={backgroundUrl(wallpaper.file) ?? ''} alt="" />
                )}
              </button>
              <button
                className="wl-name"
                title={`切换到「${wallpaper.name}」`}
                onClick={() => onSelect(index)}
              >
                {wallpaper.name}
              </button>
              <button className="btn sm ghost" onClick={() => onRemove(wallpaper.id)}>
                删除
              </button>
            </div>
          )}
        />
      )}
      <Row name="轮换方式" desc="随机：每次换一张随机的；循环：按列表顺序">
        <Segmented
          value={settings.strategy}
          onChange={(value) => onSettings({ strategy: value as WallpaperSettings['strategy'] })}
          options={[
            { value: 'loop', label: '循环' },
            { value: 'random', label: '随机' }
          ]}
        />
      </Row>
      <Row name="轮换时机" desc="到达设定时机时自动切换到下一张壁纸">
        <Segmented
          value={settings.trigger}
          onChange={(value) => onSettings({ trigger: value as WallpaperSettings['trigger'] })}
          options={TRIGGER_LABELS.map((t) => ({ value: t.value, label: t.label }))}
        />
      </Row>
      {settings.trigger === 'interval' && (
        <Row name="定时间隔" desc="每隔多少分钟自动切换一张（1-1440）">
          <InlineEdit
            value={String(settings.intervalMinutes)}
            onCommit={(v) => {
              const n = Math.max(1, Math.min(1440, parseInt(v, 10) || settings.intervalMinutes))
              onSettings({ intervalMinutes: n })
            }}
          />
        </Row>
      )}
      <Row name="背景模糊" desc="对该应用的所有壁纸统一生效">
        <div className="range-row">
          <span className="range-value">{tuning.blur} px</span>
          <input
            className="slider"
            type="range"
            min={0}
            max={40}
            value={tuning.blur}
            onChange={(e) => setTuningAnd(Number(e.target.value), tuning.dim)}
          />
        </div>
      </Row>
      <Row name="背景压暗" desc="对该应用的所有壁纸统一生效">
        <div className="range-row">
          <span className="range-value">{tuning.dim} %</span>
          <input
            className="slider"
            type="range"
            min={0}
            max={100}
            value={tuning.dim}
            onChange={(e) => setTuningAnd(tuning.blur, Number(e.target.value))}
          />
        </div>
      </Row>
    </div>
  )
}

/** Per-app linked-launch selection / order / default. */
function LinkedPanel({
  entry,
  linkedLaunches,
  onSetAppLinked,
  onEdit
}: {
  entry: AppEntry
  linkedLaunches: LinkedLaunch[]
  onSetAppLinked: (ids: string[], defaultId: string | null) => void
  onEdit: (id: string) => void
}): ReactElement {
  const selected = entry.linkedLaunchIds.filter((id) => linkedLaunches.some((l) => l.id === id))
  const defaultId = entry.defaultLinkedLaunchId ?? selected[0] ?? null
  const items = selected
    .map((id) => linkedLaunches.find((l) => l.id === id))
    .filter((l): l is LinkedLaunch => !!l)
  const def = items.find((l) => l.id === defaultId) ?? items[0] ?? null
  const others = def ? items.filter((l) => l.id !== def.id) : items

  const apply = (nextOthers: LinkedLaunch[], nextDef: string | null): void => {
    const all = def ? [def, ...nextOthers] : nextOthers
    const chosen = nextDef ?? def?.id ?? null
    const ids = all.map((l) => l.id)
    onSetAppLinked(ids, chosen && ids.includes(chosen) ? chosen : (ids[0] ?? null))
  }

  const toggle = (id: string, on: boolean): void => {
    const ids = on ? [...selected, id] : selected.filter((x) => x !== id)
    onSetAppLinked(ids, defaultId && ids.includes(defaultId) ? defaultId : (ids[0] ?? null))
  }

  const row = (
    item: LinkedLaunch,
    handle: SortableHandle | null,
    _isDefault: boolean
  ): ReactElement => (
    <div className="wl-row">
      {handle ? (
        <button
          className={`ll-grip${handle.dragging ? ' dragging' : ''}`}
          title="拖动排序"
          onPointerDown={handle.onPointerDown}
        >
          <Icon name="grip" size={16} />
        </button>
      ) : (
        <span className="method-index">默认</span>
      )}
      <button className="wl-name" title="打开关联启动设置" onClick={() => onEdit(item.id)}>
        {item.name}
      </button>
      <button
        className="btn sm ghost"
        disabled={items.length <= 1}
        onClick={() => toggle(item.id, false)}
      >
        移除
      </button>
    </div>
  )

  return (
    <div className="settings">
      <Row name="关联启动项" desc="勾选要在这个应用上显示的关联启动">
        <span className="hint">{selected.length > 0 ? `已选 ${selected.length} 项` : '未选择'}</span>
      </Row>
      {linkedLaunches.length === 0 ? (
        <div className="settings-empty">还没有关联启动项，请到左侧「关联启动」页面添加。</div>
      ) : (
        <>
          <Row name="默认关联启动" desc="点击关联启动按钮时使用的方式">
            <Select
              value={defaultId ?? ''}
              options={items.map((l) => ({ value: l.id, label: l.name }))}
              onChange={(value) => apply(others, value)}
            />
          </Row>
          {def && row(def, null, true)}
          <Sortable
            items={others}
            getKey={(l) => l.id}
            onReorder={(ids) => {
              const byId = new Map(others.map((l) => [l.id, l]))
              apply(ids.map((id) => byId.get(id)).filter((l): l is LinkedLaunch => !!l), def?.id ?? null)
            }}
            renderItem={(item, _index, handle) => row(item, handle, false)}
          />
          <div className="check-group-title">可添加</div>
          <div className="ll-apps">
            {linkedLaunches
              .filter((l) => !selected.includes(l.id))
              .map((item) => (
                <Checkbox
                  key={item.id}
                  checked={false}
                  onChange={() => toggle(item.id, true)}
                  label={item.name}
                />
              ))}
            {linkedLaunches.every((l) => selected.includes(l.id)) && (
              <span className="hint">全部已添加</span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default function ModuleManagerView({
  entry,
  linkedLaunches,
  onBack,
  onSetModule,
  onResetModulePosition,
  onSetModuleLabel,
  onSetLaunchEffect,
  onSetLaunchMethods,
  onWallpaperAdd,
  onWallpaperRemove,
  onWallpaperReorder,
  onWallpaperSettings,
  onWallpaperSelect,
  onWallpaperView,
  onBgTuning,
  onSetAppLinked,
  onEditLinkedLaunch,
  initialExpanded
}: ModuleManagerViewProps): ReactElement {
  const [expanded, setExpanded] = useState<HomeModuleId | null>(initialExpanded ?? null)
  const pageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!initialExpanded) return
    setExpanded(initialExpanded)
    const timer = window.setTimeout(() => {
      const page = pageRef.current
      const el = page?.querySelector<HTMLElement>(
        `[data-module-id="${CSS.escape(initialExpanded)}"]`
      )
      if (page && el) {
        const top =
          el.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop - 80
        page.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
      }
    }, 80)
    return () => window.clearTimeout(timer)
  }, [initialExpanded])

  const hasLinked = entry.linkedLaunchIds.some((id) => linkedLaunches.some((l) => l.id === id))

  return (
    <div className="page" ref={pageRef}>
      <div className="page-header">
        <div>
          <h1 className="page-title">模块管理</h1>
          <p className="page-subtitle">主页模块 · {entry.name}</p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={onBack}>
            返回主页
          </button>
        </div>
      </div>

      <div className="page-body">
        <div className="settings">
          {HOME_MODULES.map((module) => {
            const state: HomeModuleState = {
              ...DEFAULT_HOME_MODULE,
              ...(entry.homeModules?.[module.id] ?? {})
            }
            const hasSettings = HAS_SETTINGS.includes(module.id)
            const open = expanded === module.id
            const note =
              module.id === 'linkedLaunch' && !hasLinked ? '（该应用尚未关联任何关联启动）' : ''
            return (
              <div className="module-row" key={module.id} data-module-id={module.id}>
                <Row name={module.name} desc={module.desc + note}>
                  <div className="module-controls">
                    <Switch
                      checked={state.visible}
                      disabled={!module.hideable}
                      label="显示"
                      title={module.hideable ? '是否在主页显示' : '启动按钮不可隐藏'}
                      onChange={(visible) => onSetModule(module.id, { visible })}
                    />
                    <Switch
                      checked={state.draggable}
                      label="可拖动"
                      title="是否允许在主页拖动"
                      onChange={(draggable) => onSetModule(module.id, { draggable })}
                    />
                    <button
                      className="btn sm ghost"
                      disabled={state.x === null && state.y === null}
                      onClick={() => onResetModulePosition(module.id)}
                    >
                      重置位置
                    </button>
                    {hasSettings && (
                      <button
                        className={`btn sm ghost module-caret${open ? ' open' : ''}`}
                        title="模块设置"
                        aria-expanded={open}
                        onClick={() => setExpanded(open ? null : module.id)}
                      >
                        <Icon name="chevronDown" size={16} />
                      </button>
                    )}
                  </div>
                </Row>

                {hasSettings && (
                  <Collapse open={open}>
                    {module.id === 'info' && (
                      <Row name="模块文字" desc="信息卡片中显示的名称，留空则用绑定的游戏模块名">
                        <InlineEdit
                          value={entry.moduleLabel ?? ''}
                          placeholder="例如：原神"
                          onCommit={(v) => onSetModuleLabel(v.trim() ? v.trim() : null)}
                        />
                      </Row>
                    )}
                    {module.id === 'launch' && (
                      <LaunchMethodsEditor
                        key={entry.id}
                        methods={entry.launchMethods}
                        defaultId={entry.defaultLaunchMethodId}
                        onChange={onSetLaunchMethods}
                        effect={entry.launchEffect}
                        onEffectChange={onSetLaunchEffect}
                      />
                    )}
                    {module.id === 'wallpaper' && (
                      <WallpaperPanel
                        entry={entry}
                        onAdd={onWallpaperAdd}
                        onRemove={onWallpaperRemove}
                        onReorder={onWallpaperReorder}
                        onSettings={onWallpaperSettings}
                        onSelect={onWallpaperSelect}
                        onView={onWallpaperView}
                        onBgTuning={onBgTuning}
                      />
                    )}
                    {module.id === 'linkedLaunch' && (
                      <LinkedPanel
                        entry={entry}
                        linkedLaunches={linkedLaunches}
                        onSetAppLinked={onSetAppLinked}
                        onEdit={onEditLinkedLaunch}
                      />
                    )}
                  </Collapse>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
