import { useEffect, useState, type ReactElement } from 'react'
import type { AddonDescriptor, AddonId, AppEntry, NewAppEntry } from '@shared/types'
import { iconUrl } from '../media'
import Select from './Select'

export interface AppFormMedia {
  iconSource: string | null
  backgroundSource: string | null
  clearIcon: boolean
  clearBackground: boolean
}

interface AppFormDialogProps {
  addons: AddonDescriptor[]
  initial?: AppEntry | null
  onClose: () => void
  onSubmit: (input: NewAppEntry, media: AppFormMedia) => Promise<void>
  pickIconCropped: () => Promise<{ dataUrl: string; sourcePath: string } | null>
}

const EXECUTABLE_EXTS = ['exe', 'bat', 'cmd', 'ps1', 'lnk']

function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return index > 0 ? path.slice(0, index) : path
}

function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return (base.split('.').pop() ?? '').toLowerCase()
}

export default function AppFormDialog({
  addons,
  initial,
  onClose,
  onSubmit,
  pickIconCropped
}: AppFormDialogProps): ReactElement {
  const editing = !!initial

  const [name, setName] = useState(initial?.name ?? '')
  const [moduleLabel, setModuleLabel] = useState(initial?.moduleLabel ?? '')
  const [targetPath, setTargetPath] = useState(initial?.targetPath ?? '')
  const [arguments_, setArguments] = useState(initial?.arguments ?? '')
  const [workingDirectory, setWorkingDirectory] = useState(initial?.workingDirectory ?? '')
  const [gameDirectory, setGameDirectory] = useState(initial?.gameDirectory ?? '')
  const [addonId, setAddonId] = useState<AddonId | ''>(initial?.addonId ?? '')
  const [screenshotDirectory, setScreenshotDirectory] = useState(initial?.screenshotDirectory ?? '')
  const [monitorProcessNames, setMonitorProcessNames] = useState(
    (initial?.monitorProcessNames ?? []).join(', ')
  )

  const [iconSource, setIconSource] = useState<string | null>(null)
  const [clearIcon, setClearIcon] = useState(false)
  const [defaultIcon, setDefaultIcon] = useState<string | null>(null)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Fill name / working dir / game dir from a chosen target — only if empty. */
  const applyTargetDefaults = (path: string): void => {
    if (!targetPath.trim()) setTargetPath(path)
    const base = path.split(/[\\/]/).pop() ?? path
    if (!name.trim()) setName(base.replace(/\.[^.]+$/, ''))
    const dir = dirname(path)
    if (!workingDirectory.trim()) setWorkingDirectory(dir)
    if (!gameDirectory.trim()) setGameDirectory(dir)
  }

  const applyAddonDefaults = (addon: AddonId | ''): void => {
    if (!addon) return
    const descriptor = addons.find((a) => a.id === addon)
    if (!descriptor) return
    if (!monitorProcessNames.trim()) {
      setMonitorProcessNames(descriptor.defaultMonitorProcessNames.join(', '))
    }
    const base = targetPath.trim()
    if (base) {
      const dir = dirname(base)
      if (!workingDirectory.trim()) setWorkingDirectory(dir)
      if (!gameDirectory.trim()) setGameDirectory(dir)
    }
  }

  const pickTarget = async (): Promise<void> => {
    const path = await window.api.pickExecutable()
    if (!path) return
    applyTargetDefaults(path)
    // Default icon = the target's own icon (only when nothing is set yet).
    if (!iconSource && !clearIcon && !initial?.iconFile) {
      const dataUrl = await window.api.iconFromPath(path)
      if (dataUrl) setIconSource(dataUrl)
    }
  }
  const pickWorkDir = async (): Promise<void> => {
    const path = await window.api.pickDirectory()
    if (path) setWorkingDirectory(path)
  }
  const pickGameDir = async (): Promise<void> => {
    const path = await window.api.pickDirectory()
    if (path) setGameDirectory(path)
  }
  const pickScreenshotDir = async (): Promise<void> => {
    const path = await window.api.pickDirectory()
    if (path) setScreenshotDirectory(path)
  }
  const pickIcon = async (): Promise<void> => {
    const picked = await pickIconCropped()
    if (!picked) return
    setIconSource(picked.dataUrl)
    setClearIcon(false)
    // Picking an executable/shortcut as the icon also fills the target.
    if (EXECUTABLE_EXTS.includes(extOf(picked.sourcePath))) applyTargetDefaults(picked.sourcePath)
  }

  const submit = async (): Promise<void> => {
    if (!targetPath.trim()) {
      setError('请选择要启动的文件')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(
        {
          name: name.trim() || '未命名应用',
          moduleLabel: moduleLabel.trim() || null,
          targetPath: targetPath.trim(),
          arguments: arguments_,
          workingDirectory: workingDirectory.trim(),
          gameDirectory: gameDirectory.trim() || null,
          addonId: addonId === '' ? null : addonId,
          screenshotDirectory: screenshotDirectory.trim() || null,
          monitorProcessNames: monitorProcessNames
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        },
        { iconSource, backgroundSource: null, clearIcon, clearBackground: false }
      )
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const currentIcon = iconUrl(initial?.iconFile ?? null)

  // After "restore default icon" (or when there never was one) preview the
  // target file's own icon instead of a bare letter.
  useEffect(() => {
    const path = targetPath.trim()
    if (!clearIcon || !path) {
      setDefaultIcon(null)
      return
    }
    let cancelled = false
    void window.api.iconFromPath(path).then((dataUrl) => {
      if (!cancelled) setDefaultIcon(dataUrl)
    })
    return () => {
      cancelled = true
    }
  }, [clearIcon, targetPath])

  const preview = iconSource ?? (clearIcon ? defaultIcon : currentIcon)

  return (
    <div className="modal-mask">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{editing ? '编辑应用' : '添加应用'}</h2>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="media-row">
            <div className="media-preview">
              {preview ? <img src={preview} alt="" /> : (name[0] ?? '?').toUpperCase()}
            </div>
            <div className="media-row" style={{ gap: 8 }}>
              <button className="btn sm" onClick={pickIcon}>
                选择图标
              </button>
              {(currentIcon || iconSource) && (
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    setIconSource(null)
                    setClearIcon(true)
                  }}
                >
                  恢复默认图标
                </button>
              )}
              <span className="hint">可选图片，或选择 exe / bat / lnk 提取其图标</span>
            </div>
          </div>

          <div className="field">
            <label className="label">
              目标文件<span className="req">*</span>
            </label>
            <div className="row">
              <input
                className="input"
                value={targetPath}
                onChange={(e) => setTargetPath(e.target.value)}
                placeholder="C:\path\to\start.bat 或 game.exe"
              />
              <button className="btn" onClick={pickTarget}>
                浏览
              </button>
            </div>
          </div>

          <div className="form-grid">
            <div className="field">
              <label className="label">显示名称</label>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="我的应用"
              />
            </div>
            <div className="field">
              <label className="label">绑定游戏模块</label>
              <Select
                value={addonId}
                placeholder="（不绑定，普通应用）"
                options={[
                  { value: '', label: '（不绑定，普通应用）' },
                  ...addons.map((a) => ({ value: a.id as string, label: a.name }))
                ]}
                onChange={(value) => {
                  const next = value as AddonId | ''
                  setAddonId(next)
                  applyAddonDefaults(next)
                }}
              />
            </div>
          </div>

          <div className="field">
            <label className="label">模块文字</label>
            <input
              className="input"
              value={moduleLabel}
              onChange={(e) => setModuleLabel(e.target.value)}
              placeholder="主页左下第二行显示，留空则用绑定的游戏模块名（例如：原神）"
            />
          </div>

          <div className="field">
            <label className="label">启动参数</label>
            <input
              className="input"
              value={arguments_}
              onChange={(e) => setArguments(e.target.value)}
              placeholder='--example "quoted value"'
            />
          </div>

          <div className="field">
            <label className="label">工作目录</label>
            <div className="row">
              <input
                className="input"
                value={workingDirectory}
                onChange={(e) => setWorkingDirectory(e.target.value)}
                placeholder="留空则使用目标文件所在目录"
              />
              <button className="btn" onClick={pickWorkDir}>
                浏览
              </button>
            </div>
          </div>

          <div className="field">
            <label className="label">游戏目录（用于版本检测 / 更新，可选）</label>
            <div className="row">
              <input
                className="input"
                value={gameDirectory}
                onChange={(e) => setGameDirectory(e.target.value)}
                placeholder="例如：D:\miHoYo Launcher\games\Genshin Impact Game"
              />
              <button className="btn" onClick={pickGameDir}>
                浏览
              </button>
            </div>
          </div>

          <div className="field">
            <label className="label">截图目录</label>
            <div className="row">
              <input
                className="input"
                value={screenshotDirectory}
                onChange={(e) => setScreenshotDirectory(e.target.value)}
                placeholder="用于「图库」功能（可选）"
              />
              <button className="btn" onClick={pickScreenshotDir}>
                浏览
              </button>
            </div>
          </div>

          <div className="field">
            <label className="label">监视进程名</label>
            <input
              className="input"
              value={monitorProcessNames}
              onChange={(e) => setMonitorProcessNames(e.target.value)}
              placeholder="逗号分隔，例如：YuanShen.exe"
            />
            <span className="field-hint">
              用于快捷方式/提权启动等无法按 PID 追踪时的运行检测与时长统计
            </span>
          </div>

          {error && <div className="error">{error}</div>}
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? '保存中…' : editing ? '保存' : '添加'}
          </button>
        </div>
      </div>
    </div>
  )
}
