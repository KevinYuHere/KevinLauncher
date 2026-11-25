import { useEffect, useState, type ReactElement } from 'react'

// Custom min/max/restore/close buttons for the frameless window (the native
// title bar is hidden). Four tiny inline SVGs with two states for maximize.
function MinIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <line x1="2.6" y1="7" x2="11.4" y2="7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function MaxIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect x="2.7" y="2.7" width="8.6" height="8.6" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

function RestoreIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect x="4.4" y="2.7" width="6.9" height="6.9" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <rect x="2.7" y="4.4" width="6.9" height="6.9" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

function CloseIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M3.5 3.5l7 7M10.5 3.5l-7 7"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  )
}

export default function WindowControls(): ReactElement {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api.windowIsMaximized().then(setMaximized)
    return window.api.onWindowMaximized(setMaximized)
  }, [])

  return (
    <div className="win-controls">
      <button className="win-btn" title="最小化" onClick={() => void window.api.windowMinimize()}>
        <MinIcon />
      </button>
      <button
        className="win-btn"
        title={maximized ? '还原' : '最大化'}
        onClick={() => void window.api.windowToggleMaximize().then(setMaximized)}
      >
        {maximized ? <RestoreIcon /> : <MaxIcon />}
      </button>
      <button className="win-btn close" title="关闭" onClick={() => void window.api.windowClose()}>
        <CloseIcon />
      </button>
    </div>
  )
}
