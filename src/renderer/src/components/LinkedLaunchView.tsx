import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { AppEntry, LinkedLaunch } from '@shared/types'
import Sortable from './Sortable'
import Switch from './Switch'
import Checkbox from './Checkbox'
import Collapse from './Collapse'
import InlineEdit from './InlineEdit'
import PathField from './PathField'
import Icon from './Icon'

interface LinkedLaunchViewProps {
  linkedLaunches: LinkedLaunch[]
  apps: AppEntry[]
  /** An entry to open expanded (jumped to from the per-app module settings). */
  initialExpandedId?: string | null
  onBack: () => void
  onAdd: () => void
  onUpdate: (entry: LinkedLaunch) => void
  onRemove: (id: string) => void
  onReorder: (ids: string[]) => void
  onSetAppLinked: (appId: string, ids: string[], defaultId: string | null) => void
}

/**
 * 关联启动 — launcher-wide list of "start many apps with one file" entries. Each
 * entry can also declare which apps it is associated with; the same relation is
 * editable per app in 模块管理 (both edit the same data).
 */
export default function LinkedLaunchView({
  linkedLaunches,
  apps,
  initialExpandedId,
  onBack,
  onAdd,
  onUpdate,
  onRemove,
  onReorder,
  onSetAppLinked
}: LinkedLaunchViewProps): ReactElement {
  const [expanded, setExpanded] = useState<string | null>(initialExpandedId ?? null)
  const pageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!initialExpandedId) return
    setExpanded(initialExpandedId)
    const timer = window.setTimeout(() => {
      const page = pageRef.current
      const el = page?.querySelector<HTMLElement>(`[data-ll-id="${CSS.escape(initialExpandedId)}"]`)
      if (page && el) {
        const top =
          el.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop - 80
        page.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
      }
    }, 80)
    return () => window.clearTimeout(timer)
  }, [initialExpandedId])

  // Local editing buffer per entry (so typing is not fought by the round-trip).
  const [drafts, setDrafts] = useState<Record<string, LinkedLaunch>>({})
  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev }
      for (const item of linkedLaunches) if (!next[item.id]) next[item.id] = item
      return next
    })
  }, [linkedLaunches])

  const draftOf = (item: LinkedLaunch): LinkedLaunch => drafts[item.id] ?? item

  const patch = (item: LinkedLaunch, changes: Partial<LinkedLaunch>): void => {
    const next = { ...draftOf(item), ...changes }
    setDrafts((prev) => ({ ...prev, [item.id]: next }))
    onUpdate(next)
  }

  const membersOf = (id: string): string[] =>
    apps.filter((app) => (app.linkedLaunchIds ?? []).includes(id)).map((app) => app.id)

  const toggleApp = (chain: LinkedLaunch, appId: string, on: boolean): void => {
    const app = apps.find((a) => a.id === appId)
    if (!app) return
    const current = app.linkedLaunchIds ?? []
    const ids = on ? [...current, chain.id] : current.filter((x) => x !== chain.id)
    const defaultId =
      app.defaultLinkedLaunchId && ids.includes(app.defaultLinkedLaunchId)
        ? app.defaultLinkedLaunchId
        : (ids[0] ?? null)
    onSetAppLinked(appId, ids, defaultId)
  }

  const pickFile = async (item: LinkedLaunch): Promise<void> => {
    const path = await window.api.pickExecutable()
    if (path) patch(item, { targetPath: path })
  }

  const pickDir = async (item: LinkedLaunch): Promise<void> => {
    const path = await window.api.pickDirectory()
    if (path) patch(item, { workingDirectory: path })
  }

  return (
    <div className="page" ref={pageRef}>
      <div className="page-header">
        <div>
          <h1 className="page-title">关联启动</h1>
          <p className="page-subtitle">用一个文件一次拉起多个应用</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" onClick={onAdd}>
            新增关联启动
          </button>
          <button className="btn ghost" onClick={onBack}>
            返回主页
          </button>
        </div>
      </div>

      <div className="page-body">
        <div className="settings">
        {linkedLaunches.length === 0 ? (
          <div className="settings-empty">还没有关联启动。点击「新增关联启动」添加一个启动脚本或程序。</div>
        ) : (
          <Sortable
            items={linkedLaunches}
            getKey={(item) => item.id}
            onReorder={onReorder}
            renderItem={(item, _index, handle) => {
              const draft = draftOf(item)
              const open = expanded === item.id
              const members = membersOf(item.id)
              return (
                <div className="ll-card" data-ll-id={item.id}>
                  <div className="ll-head">
                    <button
                      className={`ll-grip${handle.dragging ? ' dragging' : ''}`}
                      title="拖动排序"
                      onPointerDown={handle.onPointerDown}
                    >
                      <Icon name="grip" size={18} />
                    </button>
                    <InlineEdit
                      className="ll-name"
                      value={draft.name}
                      placeholder="名称，例如：全部启动"
                      onCommit={(v) => patch(item, { name: v })}
                    />
                    <button
                      className={`btn sm ghost module-caret${open ? ' open' : ''}`}
                      title="更多设置"
                      onClick={() => setExpanded(open ? null : item.id)}
                    >
                      <Icon name="chevronDown" size={16} />
                    </button>
                    <button className="btn sm danger" onClick={() => onRemove(item.id)}>
                      删除
                    </button>
                  </div>

                  <Collapse open={open}>
                      <div className="settings">
                        <div className="settings-row">
                          <div className="settings-main">
                            <div className="settings-name">启动文件</div>
                            <div className="settings-desc">exe / bat / cmd / ps1 / lnk / 任意文件</div>
                          </div>
                          <div className="settings-action">
                            <PathField
                              className="wide"
                              value={draft.targetPath}
                              placeholder="点击选择文件"
                              onPick={() => void pickFile(item)}
                            />
                          </div>
                        </div>
                        <div className="settings-row">
                          <div className="settings-main">
                            <div className="settings-name">启动参数</div>
                            <div className="settings-desc">含空格请用引号（可选）</div>
                          </div>
                          <div className="settings-action">
                            <InlineEdit
                              className="wide"
                              value={draft.arguments}
                              placeholder="无"
                              onCommit={(v) => patch(item, { arguments: v })}
                            />
                          </div>
                        </div>
                        <div className="settings-row">
                          <div className="settings-main">
                            <div className="settings-name">工作目录</div>
                            <div className="settings-desc">留空则使用启动文件所在目录</div>
                          </div>
                          <div className="settings-action">
                            <PathField
                              className="wide"
                              value={draft.workingDirectory}
                              placeholder="点击选择目录"
                              onPick={() => void pickDir(item)}
                            />
                          </div>
                        </div>
                        <div className="settings-row">
                          <div className="settings-main">
                            <div className="settings-name">以管理员运行</div>
                          </div>
                          <div className="settings-action">
                            <Switch
                              checked={draft.runAsAdmin}
                              label="管理员"
                              onChange={(value) => patch(item, { runAsAdmin: value })}
                            />
                          </div>
                        </div>
                        <div className="settings-row">
                          <div className="settings-main">
                            <div className="settings-name">在游戏栏显示</div>
                            <div className="settings-desc">在游戏栏下方的关联启动行显示一个胶囊</div>
                          </div>
                          <div className="settings-action">
                            <Switch
                              checked={draft.showInGamesRow}
                              label="显示"
                              onChange={(value) => patch(item, { showInGamesRow: value })}
                            />
                          </div>
                        </div>
                        <div className="check-group-title">关联应用</div>
                        <div className="ll-apps">
                          {apps.map((app) => (
                            <Checkbox
                              key={app.id}
                              checked={members.includes(app.id)}
                              onChange={(on) => toggleApp(item, app.id, on)}
                              label={app.name}
                            />
                          ))}
                          {apps.length === 0 && <span className="hint">还没有应用</span>}
                        </div>
                      </div>
                  </Collapse>
                </div>
              )
            }}
          />
        )}
        </div>
      </div>
    </div>
  )
}
