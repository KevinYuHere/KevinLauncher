import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useOpenOrigin } from './useOpenOrigin'
import { useDialogFocus } from './useDialogFocus'

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
  const active = useRef<ConfirmState | null>(null)
  const queued = useRef<ConfirmState[]>([])
  const timer = useRef(0)
  useOpenOrigin(modalRef)

  useEffect(() => {
    show = (next) => {
      if (!next) return
      if (active.current) {
        queued.current.push(next)
        return
      }
      active.current = next
      setClosing(false)
      setState(next)
    }
    return () => {
      show = null
      window.clearTimeout(timer.current)
      active.current?.resolve(false)
      active.current = null
      for (const pending of queued.current.splice(0)) pending.resolve(false)
    }
  }, [])

  const close = (value: boolean): void => {
    if (!state || closing) return
    setClosing(true)
    timer.current = window.setTimeout(() => {
      active.current = queued.current.shift() ?? null
      state.resolve(value)
      setState(active.current)
      setClosing(false)
    }, 180)
  }
  useDialogFocus(modalRef, state !== null, () => close(false))

  if (!state) return null

  return (
    <div className={`modal-mask${closing ? ' closing' : ''}`}>
      <div
        ref={modalRef}
        role="alertdialog"
        aria-modal="true"
        aria-label="确认"
        aria-describedby="confirm-message"
        tabIndex={-1}
        className={`modal confirm-modal wallpaper-region${closing ? ' closing' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="wp-region-layer" aria-hidden="true" />
        <div className="modal-header">
          <h2>确认</h2>
        </div>
        <div className="modal-body">
          <p className="confirm-text" id="confirm-message">{state.message}</p>
        </div>
        <div className="modal-footer">
          <button className="btn" data-dialog-first onClick={() => close(false)}>
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
