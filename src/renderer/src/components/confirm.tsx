import { useEffect, useState, type ReactElement } from 'react'

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

  useEffect(() => {
    show = setState
    return () => {
      show = null
    }
  }, [])

  if (!state) return null

  const close = (value: boolean): void => {
    state.resolve(value)
    setState(null)
  }

  return (
    <div className="modal-mask">
      <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
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
