import { BrowserWindow } from 'electron'
import { handleIpc } from './access'
import { ensureTray } from '../services/behavior'

/** Frameless-window controls used by the custom title bar. */
export function registerWindowIpc(): void {
  handleIpc('window:minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })
  handleIpc('window:toggleMaximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  handleIpc('window:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })
  handleIpc('window:hideToTray', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    win.hide()
    void ensureTray()
  })
  handleIpc('window:isMaximized', (e) => {
    return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false
  })
}
