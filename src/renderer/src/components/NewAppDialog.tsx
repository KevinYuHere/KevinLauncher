import { useRef, useState, type ReactElement } from 'react'
import { useOpenOrigin } from './useOpenOrigin'
import type { AddonDescriptor, AddonId, LaunchMethod, NewAppEntry } from '@shared/types'
import Select from './Select'
import IconPicker from './IconPicker'
import LaunchMethodsEditor from './LaunchMethodsEditor'
import InlineEdit from './InlineEdit'

interface NewAppDialogProps {
  addons: AddonDescriptor[]
  onClose: () => void
  onSubmit: (input: NewAppEntry, iconDataUrl: string | null) => Promise<void>
  pickIconCropped: () => Promise<{ dataUrl: string; sourcePath: string } | null>
}

const newMethod = (index: number): LaunchMethod => ({
  id: `m-${Date.now()}-${index}`,
  name: index === 0 ? '默认' : `启动方式 ${index + 1}`,
  targetPath: '',
  arguments: '',
  workingDirectory: '',
  runAsAdmin: true
})

/**
 * Add-app dialog. The launch-method section reuses the exact same editor as the
 * launch-button settings (`LaunchMethodsEditor`); the icon picker is shared with
 * the settings pages. Launch methods may all be left blank and configured later.
 */
export default function NewAppDialog({
  addons,
  onClose,
  onSubmit,
  pickIconCropped
}: NewAppDialogProps): ReactElement {
  const [name, setName] = useState('')
  const [addonId, setAddonId] = useState<AddonId | ''>('')
  const [methods, setMethods] = useState<LaunchMethod[]>([newMethod(0)])
  const [defaultId, setDefaultId] = useState(methods[0].id)
  const [iconDataUrl, setIconDataUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  useOpenOrigin(modalRef)

  const requestClose = (): void => {
    if (closing) return
    setClosing(true)
    window.setTimeout(onClose, 180)
  }

  const pickIcon = async (): Promise<void> => {
    const picked = await pickIconCropped()
    if (picked) setIconDataUrl(picked.dataUrl)
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const ordered = [
        ...methods.filter((m) => m.id === defaultId),
        ...methods.filter((m) => m.id !== defaultId)
      ]
      const list = ordered.length > 0 ? ordered : [newMethod(0)]
      await onSubmit(
        {
          name: name.trim() || '未命名应用',
          addonId: addonId === '' ? null : addonId,
          launchMethods: list.map((m, index) => ({
            name: m.name.trim() || (index === 0 ? '默认' : `启动方式 ${index + 1}`),
            targetPath: m.targetPath.trim(),
            arguments: m.arguments,
            workingDirectory: m.workingDirectory.trim(),
            runAsAdmin: m.runAsAdmin
          }))
        },
        iconDataUrl
      )
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className={`modal-mask${closing ? ' closing' : ''}`}>
      <div
        ref={modalRef}
        className={`modal wallpaper-region${closing ? ' closing' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="wp-region-layer" aria-hidden="true" />
        <div className="modal-header">
          <h2>添加应用</h2>
          <button className="modal-close" onClick={requestClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="settings">
            <div className="settings-group-title">基本信息</div>
            <IconPicker
              small
              src={iconDataUrl}
              label="应用图标"
              desc="可选图片，或选择 exe / bat / lnk 提取其图标；选后可框选正方形并缩放。"
              onPick={() => void pickIcon()}
              onClear={iconDataUrl ? () => setIconDataUrl(null) : undefined}
            />
            <div className="settings-row">
              <div className="settings-main">
                <div className="settings-name">显示名称</div>
                <div className="settings-desc">主页与列表中的应用名称</div>
              </div>
              <div className="settings-action">
                <InlineEdit value={name} placeholder="我的应用" onCommit={setName} />
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-main">
                <div className="settings-name">绑定游戏模块</div>
                <div className="settings-desc">可选，绑定后启用更新 / 抽卡等模块功能</div>
              </div>
              <div className="settings-action">
                <Select
                  value={addonId}
                  placeholder="（不绑定，普通应用）"
                  options={[
                    { value: '', label: '（不绑定，普通应用）' },
                    ...addons.map((a) => ({ value: a.id as string, label: a.name }))
                  ]}
                  onChange={(value) => setAddonId(value as AddonId | '')}
                />
              </div>
            </div>
          </div>

          <LaunchMethodsEditor
            variant="card"
            title="启动方式（可留空，稍后在模块管理中配置）"
            methods={methods}
            defaultId={defaultId}
            onChange={(next, nextDefault) => {
              setMethods(next)
              setDefaultId(nextDefault)
            }}
          />

          {error && <div className="error">{error}</div>}
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={requestClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '添加中…' : '添加'}
          </button>
        </div>
      </div>
    </div>
  )
}
