import { useState, type ReactElement } from 'react'
import { LAUNCH_EFFECTS, type LaunchEffect, type LaunchMethod } from '@shared/types'
import Icon from './Icon'
import Sortable from './Sortable'
import Select from './Select'
import Segmented from './Segmented'
import Switch from './Switch'
import InlineEdit from './InlineEdit'
import PathField from './PathField'
import { confirm } from './confirm'

interface LaunchMethodsEditorProps {
  methods: LaunchMethod[]
  defaultId: string
  onChange: (methods: LaunchMethod[], defaultId: string) => void
  /** Optional launch-effect row, rendered right after the default choice. */
  effect?: LaunchEffect
  onEffectChange?: (effect: LaunchEffect) => void
  /** Optional section title rendered as the first row of the card. */
  title?: string
  /**
   * `drawer` = the module-manager layout (method cards with a grip header);
   * `card` = a flatter layout tailored to the add-app dialog's card.
   */
  variant?: 'drawer' | 'card'
}

/**
 * The launch-method editor. Owns its list locally (edits show immediately) and
 * propagates every change up. The default method is pinned first (not
 * draggable); the others are drag-sortable and numbered #1…
 */
export default function LaunchMethodsEditor({
  methods: initialMethods,
  defaultId: initialDefaultId,
  onChange,
  effect,
  onEffectChange,
  title,
  variant = 'drawer'
}: LaunchMethodsEditorProps): ReactElement {
  const [methods, setMethods] = useState<LaunchMethod[]>(initialMethods)
  const [defaultId, setDefaultId] = useState(initialDefaultId)

  const def = methods.find((m) => m.id === defaultId) ?? methods[0] ?? null
  const others = def ? methods.filter((m) => m.id !== def.id) : methods

  const commit = (next: LaunchMethod[], nextDefault = defaultId): void => {
    if (next.length === 0) return
    const chosen = next.some((m) => m.id === nextDefault) ? nextDefault : next[0].id
    const defaultMethod = next.find((m) => m.id === chosen)!
    const ordered = [defaultMethod, ...next.filter((m) => m.id !== chosen)]
    setMethods(ordered)
    setDefaultId(chosen)
    onChange(ordered, chosen)
  }

  const patch = (id: string, changes: Partial<LaunchMethod>): void =>
    setMethods((prev) => prev.map((m) => (m.id === id ? { ...m, ...changes } : m)))

  const remove = async (id: string): Promise<void> => {
    if (!(await confirm('确定删除该启动方式吗？'))) return
    commit(methods.filter((m) => m.id !== id))
  }

  const pickFile = async (id: string): Promise<void> => {
    const path = await window.api.pickExecutable()
    if (path) commit(methods.map((m) => (m.id === id ? { ...m, targetPath: path } : m)))
  }

  const pickDir = async (id: string): Promise<void> => {
    const path = await window.api.pickDirectory()
    if (path) commit(methods.map((m) => (m.id === id ? { ...m, workingDirectory: path } : m)))
  }

  const fields = (method: LaunchMethod): ReactElement => (
    <>
      <div className="settings-row field-row">
        <div className="settings-main">
          <div className="settings-name">启动文件</div>
          <div className="settings-desc">exe / bat / cmd / ps1 / lnk，可留空</div>
        </div>
        <div className="settings-action">
          <PathField
            value={method.targetPath}
            placeholder="点击选择文件"
            onPick={() => void pickFile(method.id)}
          />
        </div>
      </div>
      <div className="settings-row field-row">
        <div className="settings-main">
          <div className="settings-name">启动参数</div>
          <div className="settings-desc">传给目标程序的命令行参数（可选）</div>
        </div>
        <div className="settings-action">
          <InlineEdit
            value={method.arguments}
            placeholder="无"
            onCommit={(v) => patch(method.id, { arguments: v })}
          />
        </div>
      </div>
      <div className="settings-row field-row">
        <div className="settings-main">
          <div className="settings-name">工作目录</div>
          <div className="settings-desc">留空则使用启动文件所在目录</div>
        </div>
        <div className="settings-action">
          <PathField
            value={method.workingDirectory}
            placeholder="点击选择目录"
            onPick={() => void pickDir(method.id)}
          />
        </div>
      </div>
      <div className="settings-row field-row">
        <div className="settings-main">
          <div className="settings-name">以管理员运行</div>
          <div className="settings-desc">以管理员权限启动该方式</div>
        </div>
        <div className="settings-action">
          <Switch
            checked={method.runAsAdmin}
            label="管理员"
            onChange={(v) => patch(method.id, { runAsAdmin: v })}
          />
        </div>
      </div>
    </>
  )

  const row = (name: string, desc: string, action: ReactElement): ReactElement => (
    <div className="settings-row">
      <div className="settings-main">
        <div className="settings-name">{name}</div>
        <div className="settings-desc">{desc}</div>
      </div>
      <div className="settings-action">{action}</div>
    </div>
  )

  const addButton = (
    <button
      type="button"
      className="btn sm"
      onClick={() =>
        commit([
          ...methods,
              {
                id: `m-${Date.now()}-${methods.length}`,
                name: `启动方式 ${methods.length + 1}`,
                targetPath: '',
                arguments: '',
                workingDirectory: '',
                runAsAdmin: true
              }
        ])
      }
    >
      添加启动方式
    </button>
  )

  return (
    <div className={`settings launch-editor launch-editor--${variant}`}>
      {title && <div className="settings-group-title">{title}</div>}
      {row(
        '默认启动方式',
        '点击启动按钮时使用的方式（自动置顶，不可拖动）',
        <Select
          value={defaultId}
          options={methods.map((m) => ({ value: m.id, label: m.name || '未命名' }))}
          onChange={(value) => commit(methods, value)}
        />
      )}
      {effect != null &&
        onEffectChange &&
        row(
          '启动特效',
          LAUNCH_EFFECTS.find((e) => e.id === effect)?.desc ?? '不播放启动特效',
          <Segmented
            value={effect}
            onChange={(value) => onEffectChange(value as LaunchEffect)}
            options={LAUNCH_EFFECTS.map((e) => ({ value: e.id, label: e.label }))}
          />
        )}

      {variant === 'drawer'
        ? def && (
            <div className="method-card method-card-pinned">
              <div className="method-card-head">
                <span className="method-index">默认</span>
                <InlineEdit
                  className="method-name"
                  value={def.name}
                  placeholder="名称"
                  onCommit={(v) => patch(def.id, { name: v })}
                />
                <span className="method-spacer" />
                <button
                  type="button"
                  className="btn sm danger"
                  disabled={methods.length <= 1}
                  onClick={() => void remove(def.id)}
                >
                  删除
                </button>
              </div>
              {fields(def)}
            </div>
          )
        : def && (
            <div className="method-block">
              <div className="settings-row">
                <div className="settings-main">
                  <div className="method-head-inline">
                    <span className="method-index">默认</span>
                    <InlineEdit
                      className="method-name"
                      value={def.name}
                      placeholder="名称"
                      onCommit={(v) => patch(def.id, { name: v })}
                    />
                  </div>
                </div>
                <div className="settings-action">
                  <button
                    type="button"
                    className="btn sm danger"
                    disabled={methods.length <= 1}
                    onClick={() => void remove(def.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
              {fields(def)}
            </div>
          )}

      <Sortable
        items={others}
        getKey={(m) => m.id}
        onReorder={(ids) => {
          const byId = new Map(others.map((m) => [m.id, m]))
          const ordered = ids.map((id) => byId.get(id)).filter((m): m is LaunchMethod => !!m)
          commit(def ? [def, ...ordered] : ordered)
        }}
        renderItem={(method, index, handle) =>
          variant === 'drawer' ? (
            <div className="method-card">
              <div className="method-card-head">
                <button
                  type="button"
                  className={`ll-grip${handle.dragging ? ' dragging' : ''}`}
                  title="拖动排序"
                  onPointerDown={handle.onPointerDown}
                >
                  <Icon name="grip" size={16} />
                </button>
                <span className="method-index">{`#${index + 1}`}</span>
                <InlineEdit
                  className="method-name"
                  value={method.name}
                  placeholder="名称"
                  onCommit={(v) => patch(method.id, { name: v })}
                />
                <span className="method-spacer" />
                <button
                  type="button"
                  className="btn sm danger"
                  disabled={methods.length <= 1}
                  onClick={() => void remove(method.id)}
                >
                  删除
                </button>
              </div>
              {fields(method)}
            </div>
          ) : (
            <div className="method-block">
              <div className="settings-row">
                <div className="settings-main">
                  <div className="method-head-inline">
                    <button
                      type="button"
                      className={`ll-grip${handle.dragging ? ' dragging' : ''}`}
                      title="拖动排序"
                      onPointerDown={handle.onPointerDown}
                    >
                      <Icon name="grip" size={16} />
                    </button>
                    <span className="method-index">{`#${index + 1}`}</span>
                    <InlineEdit
                      className="method-name"
                      value={method.name}
                      placeholder="名称"
                      onCommit={(v) => patch(method.id, { name: v })}
                    />
                  </div>
                </div>
                <div className="settings-action">
                  <button
                    type="button"
                    className="btn sm danger"
                    disabled={methods.length <= 1}
                    onClick={() => void remove(method.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
              {fields(method)}
            </div>
          )
        }
      />

      <div className="settings-row">
        <div className="settings-main">
          <div className="settings-name">其它启动方式</div>
          <div className="settings-desc">把同一个应用以不同文件 / 参数 / 目录启动</div>
        </div>
        <div className="settings-action">{addButton}</div>
      </div>
    </div>
  )
}
