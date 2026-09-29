import { useState, type ReactElement } from 'react'
import type { AppUpdateInfo } from '@shared/types'

interface AppUpdateDialogProps {
  info: AppUpdateInfo
  onDismiss: () => void
}

/**
 * Frosted "new version found" dialog: title shows the version, the body shows
 * the release notes, and the bottom-right offers 暂不更新 / 立即更新.
 * (Like the other modals it only closes through its buttons.)
 */
export default function AppUpdateDialog({ info, onDismiss }: AppUpdateDialogProps): ReactElement {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.api.appUpdateRun()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask">
      <div className="modal update-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>检测到新版本 {info.version}</h2>
        </div>
        <div className="modal-body">
          <div className="update-notes">{info.notes || '该版本没有提供更新说明。'}</div>
          {error && <p className="update-error">更新失败：{error}</p>}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onDismiss} disabled={busy}>
            暂不更新
          </button>
          <button className="btn primary" onClick={() => void run()} disabled={busy}>
            {busy ? '正在准备…' : '立即更新'}
          </button>
        </div>
      </div>
    </div>
  )
}
