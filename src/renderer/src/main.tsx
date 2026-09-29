import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import Viewer from './Viewer'
import Installer from './components/Installer'
import Uninstaller from './components/Uninstaller'
import './assets/main.css'

// One HTML entry point, several roles (the main process loads it with a hash):
//   #uninstall   self-drawn uninstall UI  (`KevinLauncher.exe --uninstall`)
//   #install     self-drawn install UI    (KevinLauncher-Setup-<ver>.exe)
//   #viewer=...  image viewer window      (gallery)
//   (none)       the launcher itself
const hash = window.location.hash
const viewerMatch = /viewer=([^&]+)/.exec(hash)

const root = viewerMatch ? (
  <Viewer path={decodeURIComponent(viewerMatch[1])} />
) : hash.includes('uninstall') ? (
  <Uninstaller />
) : hash.includes('install') ? (
  <Installer />
) : (
  <App />
)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{root}</React.StrictMode>
)
