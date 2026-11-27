import type { ReactElement } from 'react'
import Collapse from './Collapse'
import HudRow from './KevinHudRow'
import Select from './Select'

/**
 * The copy panel only needs the source id and label. Cloning and saving the
 * source config stay in the HUD editor, so this view never touches app data.
 */
export interface KevinHudCopyOption {
  id: string
  name: string
}

export interface KevinHudCopyState {
  /** Collapsed on render; the editor opens it through a user action. */
  open: boolean
  loading: boolean
  /** First-read failure. Retry uses the same parent-owned loader. */
  error: string
  /** `null` until the first successful read; `[]` means no other app has settings. */
  sources: readonly KevinHudCopyOption[] | null
  selectedId: string
  notice: string
}

export interface KevinHudCopyActions {
  onToggle: () => void
  onSelect: (id: string) => void
  onReload: () => void
  onApply: () => void
}

export interface KevinHudCopySettingsProps {
  appName: string
  state: KevinHudCopyState
  actions: KevinHudCopyActions
}

/**
 * "复制其他应用的 HUD 设置" leads the expanded editor. The parent keeps the
 * async read, revision/save and preview rules; this component only renders the
 * shared Collapse, setting row and the current copy state.
 */
export default function KevinHudCopySettings({
  appName,
  state,
  actions
}: KevinHudCopySettingsProps): ReactElement {
  const { open, loading, error, sources, selectedId, notice } = state
  const options = (sources ?? []).map((source) => ({
    value: source.id,
    label: source.name
  }))

  return (
    <div className="kh-copy">
      <Collapse
        open={open}
        header={
          <div className="kh-copy-head">
            <div className="kh-copy-main">
              <div className="kh-metric-name">复制其他应用的 HUD 设置</div>
              <div className="kh-metric-desc">
                选一套已经调好的设置应用到「{appName}」，来源应用不会改变
              </div>
            </div>
            <button
              type="button"
              className="btn sm ghost"
              aria-expanded={open}
              aria-controls="kevin-hud-copy-settings"
              onClick={actions.onToggle}
            >
              {open ? '收起' : '选择来源'}
            </button>
          </div>
        }
      >
        <div
          className="kh-copy-body"
          id="kevin-hud-copy-settings"
          aria-busy={loading}
        >
          {loading ? (
            <div className="kh-copy-state" role="status">
              正在读取其他应用…
            </div>
          ) : error ? (
            <div className="kh-copy-state error" role="status">
              <span>读取应用失败：{error}</span>
              <button
                type="button"
                className="btn sm ghost"
                onClick={actions.onReload}
              >
                重试
              </button>
            </div>
          ) : sources !== null && sources.length === 0 ? (
            <div className="kh-copy-state" role="status">
              <span>还没有其他应用可以复制。先在别的应用里保存一套 HUD 设置吧。</span>
              <button
                type="button"
                className="btn sm ghost"
                onClick={actions.onReload}
              >
                重新读取
              </button>
            </div>
          ) : (
            <>
              <HudRow
                name="来源应用"
                desc="只读取它的设置；应用后会覆盖当前应用这套 HUD，来源保持原样"
                action={
                  <Select
                    value={selectedId}
                    options={options}
                    onChange={actions.onSelect}
                  />
                }
              />
              <div className="kh-copy-actions">
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={!selectedId || loading}
                  onClick={actions.onApply}
                >
                  应用这套设置
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={actions.onReload}
                >
                  重新读取
                </button>
                <span
                  className={`kh-copy-status${error ? ' error' : ''}`}
                  role="status"
                  aria-live="polite"
                >
                  {error
                    ? `读取失败：${error}`
                    : notice || '应用后会立即保存；如果正在预览，也会同步更新。'}
                </span>
              </div>
            </>
          )}
        </div>
      </Collapse>
    </div>
  )
}
