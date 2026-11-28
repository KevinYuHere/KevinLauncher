import { useRef, useState, type ReactElement } from 'react'
import { useOpenOrigin } from './useOpenOrigin'
import { useDialogFocus } from './useDialogFocus'
import type { AppUpdateInfo } from '@shared/types'

interface AppUpdateDialogProps {
  info: AppUpdateInfo
  /** Begin the download (progress then lives in the rail indicator). */
  onStart: () => void
  onDismiss: () => void
}

/**
 * Frosted "new version found" dialog: the title shows the version, the body the
 * release notes and the bottom-right offers 暂不更新 / 下载并更新. Starting the
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
  useDialogFocus(modalRef, true, critical ? undefined : () => run(onDismiss))
  return (
    <div className={`modal-mask${closing ? ' closing' : ''}`}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${critical ? '重要更新' : '发现新版本'} ${info.version}`}
        tabIndex={-1}
        className={`modal update-modal wallpaper-region${critical ? ' is-critical' : ''}${closing ? ' closing' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="wp-region-layer" aria-hidden="true" />
        <div className="modal-header">
          <h2>
            {critical ? '重要更新' : '发现新版本'} {info.version}
          </h2>
        </div>
        <div className="modal-body">
          {critical ? (
            <div className="update-critical-hint">
              此版本为重要更新。下载会自动开始，下载期间不能跳过或暂停。下载完成后会继续更新。直接在应用内更新时，启动器会自动重启。若弹出安装程序，请按提示完成安装，然后用「立即启动」打开启动器。
            </div>
          ) : (
            <p className="hint">
              下载完成后会继续更新。直接在应用内更新时，启动器会自动重启。若弹出安装程序，请按提示完成安装，然后用「立即启动」打开启动器。
            </p>
          )}
          <div className="update-notes">{info.notes || '此版本没有提供更新说明。'}</div>
        </div>
        <div className="modal-footer">
          {!critical && (
            <button className="btn" onClick={() => run(onDismiss)}>
              暂不更新
            </button>
          )}
          <button className="btn primary" onClick={() => run(onStart)}>
            {critical ? '开始下载' : '下载并更新'}
          </button>
        </div>
      </div>
    </div>
  )
}
