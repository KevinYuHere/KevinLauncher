import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import Viewer from './Viewer'
import './assets/main.css'

// The image viewer reuses this same HTML entry point via a `#viewer=<path>`
// hash, so it can be opened in its own (frameless) BrowserWindow.
const viewerMatch = /viewer=([^&]+)/.exec(window.location.hash)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {viewerMatch ? <Viewer path={decodeURIComponent(viewerMatch[1])} /> : <App />}
  </React.StrictMode>
)
