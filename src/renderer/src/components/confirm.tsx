import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useOpenOrigin } from './useOpenOrigin'

interface ConfirmState {
  message: string
  resolve: (value: boolean) => void
}

let show: ((state: ConfirmState | null) => void) | null = null

/** Frosted in-app confirmation — replaces the native `window.confirm`. */
export function confirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!show) {
      resolve(false)
      return
    }
    show({ message, resolve })
  })
}

/** Mount once (in App). Renders the current confirmation, if any. */
export function ConfirmHost(): ReactElement | null {
  const [state, setState] = useState<ConfirmState | null>(null)
  const [closing, setClosing] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  useOpenOrigin(modalRef)

  useEffect(() => {
    show = (next) => {
      setClosing(false)
      setState(next)
    }
    return () => {
      show = null
    }
  }, [])

  if (!state) return null

  const close = (value: boolean): void => {
    if (closing) return
    setClosing(true)
    window.setTimeout(() => {
      state.resolve(value)
      setState(null)
    }, 180)
  }

  return (
    <div className={`modal-mask${closing ? ' closing' : ''}`}>
      <div
        ref={modalRef}
        className={`modal confirm-modal wallpaper-region${closing ? ' closing' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="wp-region-layer" aria-hidden="true" />
        <div className="modal-header">
          <h2>确认</h2>
        </div>
        <div className="modal-body">
          <p className="confirm-text">{state.message}</p>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={() => close(false)}>
            取消
          </button>
          <button className="btn primary" onClick={() => close(true)}>
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
