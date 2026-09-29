import { useEffect, useState, type ReactElement } from 'react'
import type { AppUpdateInfo, AppUpdateProgress } from '@shared/types'
import { formatBytes } from '../format'

interface AppUpdateDialogProps {
  info: AppUpdateInfo
  onDismiss: () => void
}

/**
 * Frosted "new version found" dialog: title shows the version, the body shows
 * the release notes, and the bottom-right offers 暂不更新 / 立即更新. While the
 * installer is being fetched it shows the (differential) download progress.
 * Like the other modals it only closes through its buttons.
 */
export default function AppUpdateDialog({ info, onDismiss }: AppUpdateDialogProps): ReactElement {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null)

  useEffect(() => window.api.onAppUpdateProgress(setProgress), [])

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.api.appUpdateRun()
    } catch (e) {
      setError((e as Error).message)
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

          {busy && (
            <div className="update-progress">
              <div className="update-progress-track">
                <span style={{ width: `${Math.min(100, progress?.percent ?? 0)}%` }} />
              </div>
              <div className="update-progress-text">
                {progress
                  ? `${progress.percent.toFixed(1)}% · ${formatBytes(progress.transferred)} / ${formatBytes(progress.total)}`
                  : '正在准备下载…（仅下载改动的部分）'}
              </div>
            </div>
          )}

          {error && <p className="update-error">更新失败：{error}</p>}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onDismiss} disabled={busy}>
            暂不更新
          </button>
          <button className="btn primary" onClick={() => void run()} disabled={busy}>
            {busy ? '正在下载…' : '立即更新'}
          </button>
        </div>
      </div>
    </div>
  )
}
