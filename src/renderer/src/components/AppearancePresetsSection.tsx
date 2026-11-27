import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { type AppearancePresetSummary } from '@shared/appearancePreset'
import { confirm } from './confirm'
import { showToast } from './toast'

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^\[[A-Z_]+\]\s*/, '')

const updatedLabel = (value: string): string => {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
    : '—'
}

/** Launcher-settings section for local appearance presets. */
interface AppearancePresetsSectionProps {
  /** True while the settings page has an unsaved glass change in flight. */
  disabled?: boolean
}

export default function AppearancePresetsSection({
  disabled = false
}: AppearancePresetsSectionProps): ReactElement {
  const [presets, setPresets] = useState<AppearancePresetSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      setPresets(await window.api.appearancePresetsList())
    } catch (loadError) {
      setError(`读取外观预设失败：${errorText(loadError)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const apply = async (preset: AppearancePresetSummary): Promise<void> => {
    if (disabled) return
    setBusyId(preset.id)
    setError('')
    try {
      const result = await window.api.appearancePresetsApply(preset.id)
      showToast(
        `已应用外观预设「${result.presetName}」：${result.apps} 个应用、${result.areas} 个界面区域`
      )
    } catch (applyError) {
      const message = errorText(applyError)
      setError(`应用外观预设失败：${message}`)
      showToast(`应用外观预设失败：${message}`)
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (preset: AppearancePresetSummary): Promise<void> => {
    if (disabled) return
    const ok = await confirm(`删除外观预设「${preset.name}」？只删除预设，不会改动当前外观。`)
    if (!ok) return
    setBusyId(preset.id)
    setError('')
    try {
      setPresets(await window.api.appearancePresetsRemove(preset.id))
      showToast(`已删除「${preset.name}」`)
    } catch (removeError) {
      const message = errorText(removeError)
      setError(`删除外观预设失败：${message}`)
      showToast(`删除外观预设失败：${message}`)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <div className="settings-group-title">外观预设</div>
      {error && (
        <div className="preset-error" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <div className="preset-empty">正在读取外观预设…</div>
      ) : presets.length === 0 ? (
        <div className="preset-empty">还没有外观预设。</div>
      ) : (
        <div className="preset-list">
          {presets.map((preset) => {
            const busy = busyId === preset.id
            return (
              <div className="preset-item" key={preset.id}>
                <div className="preset-item-main">
                  <div className="preset-item-name">{preset.name}</div>
                  <div className="preset-item-meta">
                    {preset.appCount} 个应用 · {preset.themedAreaCount}/28 个界面区域 · 更新于{' '}
                    {updatedLabel(preset.updatedAt)}
                  </div>
                </div>
                <div className="preset-item-actions">
                  <button
                    className="btn sm"
                    disabled={busyId !== null || disabled}
                    onClick={() => void apply(preset)}
                  >
                    {busy ? '应用中…' : '应用预设'}
                  </button>
                  <button
                    className="btn sm ghost"
                    disabled={busyId !== null || disabled}
                    onClick={() => void remove(preset)}
                  >
                    删除
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
