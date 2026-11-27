import React from 'react'
import ReactDOM from 'react-dom/client'
import './assets/main.css'

// One HTML entry point, several roles (the main process loads it with a hash):
//   #uninstall   self-drawn uninstall UI  (`KevinLauncher.exe --uninstall`)
//   #install     self-drawn install UI    (KevinLauncher-Setup-<ver>.exe)
//   #viewer=...  image viewer window      (gallery)
//   (none)       the launcher itself
const hash = window.location.hash
const viewerMatch = /^#viewer=([^&]+)$/.exec(hash)

async function loadRole(): Promise<React.ReactElement> {
  if (viewerMatch) {
    const { default: Viewer } = await import('./Viewer')
    return <Viewer path={decodeURIComponent(viewerMatch[1])} />
  }
  if (hash === '#uninstall') {
    const { default: Uninstaller } = await import('./components/Uninstaller')
    return <Uninstaller />
  }
  if (hash === '#install') {
    const { default: Installer } = await import('./components/Installer')
    return <Installer />
  }
  const { default: App } = await import('./App')
  return <App />
}

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)
void loadRole().then((view) => root.render(<React.StrictMode>{view}</React.StrictMode>), (error) => {
  console.error(error)
  root.render(<div className="welcome glass" role="alert">
    <p>页面加载失败</p>
    <button className="btn" onClick={() => location.reload()}>重新加载</button>
  </div>)
})
