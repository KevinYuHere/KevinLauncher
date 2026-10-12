import { useEffect, useState, type ReactElement } from 'react'
import {
  DEFAULT_HOME_MODULE,
  HOME_MODULES,
  LAUNCH_EFFECTS,
  type AppEntry,
  type HomeModuleId,
  type HomeModuleState,
  type LaunchEffect
} from '@shared/types'
import Switch from './Switch'
import Segmented from './Segmented'
import Icon from './Icon'

interface ModuleManagerViewProps {
  entry: AppEntry
  onBack: () => void
  onSetModule: (moduleId: HomeModuleId, patch: Partial<HomeModuleState>) => void
  onResetModulePosition: (moduleId: HomeModuleId) => void
  onSetModuleLabel: (label: string | null) => void
  onSetLaunchEffect: (effect: LaunchEffect) => void
}

/** Modules whose row can be expanded to reveal per-module settings. */
const HAS_SETTINGS: HomeModuleId[] = ['info', 'launch']

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

/**
 * 模块管理 — per-app home-screen module control. Modules come from the shared
 * registry, so adding a new home module only requires registering it there.
 * Modules that own settings expose a caret that expands an inline panel laid
 * out like the launcher settings page.
 */
export default function ModuleManagerView({
  entry,
  onBack,
  onSetModule,
  onResetModulePosition,
  onSetModuleLabel,
  onSetLaunchEffect
}: ModuleManagerViewProps): ReactElement {
  const [expanded, setExpanded] = useState<HomeModuleId | null>(null)
  const [label, setLabel] = useState(entry.moduleLabel ?? '')

  useEffect(() => {
    setLabel(entry.moduleLabel ?? '')
  }, [entry.id, entry.moduleLabel])

  const commitLabel = (): void => {
    const next = label.trim() ? label.trim() : null
    if (next !== (entry.moduleLabel ?? null)) onSetModuleLabel(next)
  }

  const effectDesc =
    LAUNCH_EFFECTS.find((e) => e.id === entry.launchEffect)?.desc ?? '不播放启动特效'

  return (
    <div className="page">
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
            return (
              <div className="module-row" key={module.id}>
                <Row name={module.name} desc={module.desc}>
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
                  <div className={`module-settings${open ? ' open' : ''}`}>
                    <div className="module-settings-inner">
                    {module.id === 'info' && (
                      <Row name="模块文字" desc="信息卡片中显示的名称，留空则用绑定的游戏模块名">
                        <input
                          className="input"
                          value={label}
                          placeholder="例如：原神"
                          onChange={(e) => setLabel(e.target.value)}
                          onBlur={commitLabel}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                          }}
                        />
                      </Row>
                    )}
                    {module.id === 'launch' && (
                      <Row name="启动特效" desc={effectDesc}>
                        <Segmented
                          value={entry.launchEffect}
                          onChange={(value) => onSetLaunchEffect(value as LaunchEffect)}
                          options={LAUNCH_EFFECTS.map((effect) => ({
                            value: effect.id,
                            label: effect.label
                          }))}
                        />
                      </Row>
                    )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
