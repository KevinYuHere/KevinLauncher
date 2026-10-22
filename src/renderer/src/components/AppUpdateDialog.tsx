import { useRef, useState, type ReactElement } from 'react'
import { useOpenOrigin } from './useOpenOrigin'
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
 *
 * A **critical** update has no skip action at all: it starts by itself and the
 * dialog stays until the download has taken over (the rail ring then shows it).
 */
export default function AppUpdateDialog({
  info,
  onStart,
  onDismiss
}: AppUpdateDialogProps): ReactElement {
  const [closing, setClosing] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  useOpenOrigin(modalRef)
  const critical = info.critical === true
  const run = (fn: () => void): void => {
    if (closing) return
    setClosing(true)
    window.setTimeout(fn, 180)
  }
  return (
    <div className={`modal-mask${closing ? ' closing' : ''}`}>
      <div
        ref={modalRef}
        className={`modal update-modal wallpaper-region${critical ? ' is-critical' : ''}${closing ? ' closing' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="wp-region-layer" aria-hidden="true" />
        <div className="modal-header">
          <h2>
            {critical ? '重要更新' : '检测到新版本'} {info.version}
          </h2>
        </div>
        <div className="modal-body">
          {critical && (
            <div className="update-critical-hint">
              此版本为重要更新：检测到后会立即开始下载，完成前无法跳过或暂停。
            </div>
          )}
          <div className="update-notes">{info.notes || '该版本没有提供更新说明。'}</div>
        </div>
        <div className="modal-footer">
          {!critical && (
            <button className="btn" onClick={() => run(onDismiss)}>
              暂不更新
            </button>
          )}
          <button className="btn primary" onClick={() => run(onStart)}>
            {critical ? '立即开始' : '立即更新'}
          </button>
        </div>
      </div>
    </div>
  )
}
