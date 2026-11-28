import { useEffect, useRef, useState, type ReactElement } from 'react'
import { LAUNCH_EFFECTS, type LaunchEffect, type LaunchMethod } from '@shared/types'
import { dataErrorDetails } from '@shared/dataErrors'
import Sortable from './Sortable'
import SortableGrip from './SortableGrip'
import Select from './Select'
import Switch from './Switch'
import InlineEdit from './InlineEdit'
import PathField from './PathField'
import { confirm } from './confirm'
import { showToast } from './toast'

interface LaunchMethodsEditorProps {
  methods: LaunchMethod[]
  defaultId: string
  onChange: (methods: LaunchMethod[], defaultId: string) => Promise<void> | void
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
  const draft = useRef({ methods: initialMethods, defaultId: initialDefaultId })
  const saved = useRef(draft.current)
  const revision = useRef(0)
  const writes = useRef(Promise.resolve())
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const def = methods.find((m) => m.id === defaultId) ?? methods[0] ?? null
  const others = def ? methods.filter((m) => m.id !== def.id) : methods

  const commit = (next: LaunchMethod[], nextDefault = draft.current.defaultId): void => {
    if (!mounted.current || next.length === 0) return
    const chosen = next.some((m) => m.id === nextDefault) ? nextDefault : next[0].id
    const defaultMethod = next.find((m) => m.id === chosen)!
    const ordered = [defaultMethod, ...next.filter((m) => m.id !== chosen)]
    draft.current = { methods: ordered, defaultId: chosen }
    setMethods(ordered)
    setDefaultId(chosen)
    const generation = ++revision.current
    writes.current = writes.current.then(async () => {
      try {
        await onChange(ordered, chosen)
        saved.current = { methods: ordered, defaultId: chosen }
      } catch (error) {
        const detail = dataErrorDetails(error)?.message ??
          (error instanceof Error ? error.message : String(error))
        showToast(`启动方式保存失败：${detail}`)
        if (mounted.current && revision.current === generation) {
          draft.current = saved.current
          setMethods(saved.current.methods)
          setDefaultId(saved.current.defaultId)
        }
      }
    })
  }

  const patch = (id: string, changes: Partial<LaunchMethod>): void => {
    if (!draft.current.methods.some((method) => method.id === id)) return
    commit(draft.current.methods.map((m) => (m.id === id ? { ...m, ...changes } : m)))
  }

  const remove = async (id: string): Promise<void> => {
    if (!(await confirm('确定删除这个启动方式吗？删除后，这个启动入口会从列表消失，应用和磁盘文件不受影响。'))) return
    commit(draft.current.methods.filter((m) => m.id !== id))
  }

  const pickFile = async (id: string): Promise<void> => {
    const path = await window.api.pickExecutable()
    if (path) patch(id, { targetPath: path })
  }

  const pickDir = async (id: string): Promise<void> => {
    const path = await window.api.pickDirectory()
    if (path) patch(id, { workingDirectory: path })
  }

  const fields = (method: LaunchMethod): ReactElement => (
    <>
      <div className="settings-row field-row">
        <div className="settings-main">
          <div className="settings-name">启动文件</div>
          <div className="settings-desc">支持 exe / bat / cmd / ps1 / lnk；可留空，稍后再设置</div>
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
          <div className="settings-desc">按程序需要填写，通常可以留空；含空格的参数请加引号</div>
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
          <div className="settings-name">管理员身份运行</div>
          <div className="settings-desc">启动时请求管理员权限；仅在程序确实需要修改受保护的系统设置或文件时开启</div>
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
                id: crypto.randomUUID(),
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
        '点击启动按钮时直接使用；它会排在列表最前，不能拖动排序',
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
          <Select
            value={effect}
            options={LAUNCH_EFFECTS.map((e) => ({ value: e.id, label: e.label }))}
            onChange={(value) => onEffectChange(value as LaunchEffect)}
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
                <SortableGrip handle={handle} />
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
                    <SortableGrip handle={handle} />
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
          <div className="settings-name">更多启动方式</div>
          <div className="settings-desc">为同一个应用添加另一套启动文件、参数或工作目录</div>
        </div>
        <div className="settings-action">{addButton}</div>
      </div>
    </div>
  )
}
