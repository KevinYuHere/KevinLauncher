import type { ReactElement } from 'react'
import type { AppUpdateInfo } from '@shared/types'

interface AppUpdateDialogProps {
  info: AppUpdateInfo
  /** Begin the download (progress then lives in the rail indicator). */
  onStart: () => void
  onDismiss: () => void
}

/**
 * Frosted "new version found" dialog: the title shows the version, the body the
 * release notes and the bottom-right offers 暂不更新 / 立即更新. Starting the
 * download closes it and the rail ring takes over. Like the other modals it only
 * closes through its buttons.
 */
export default function AppUpdateDialog({
  info,
  onStart,
  onDismiss
}: AppUpdateDialogProps): ReactElement {
  return (
    <div className="modal-mask">
      <div className="modal update-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>检测到新版本 {info.version}</h2>
        </div>
        <div className="modal-body">
          <div className="update-notes">{info.notes || '该版本没有提供更新说明。'}</div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onDismiss}>
            暂不更新
          </button>
          <button className="btn primary" onClick={onStart}>
            立即更新
          </button>
        </div>
      </div>
    </div>
  )
}
