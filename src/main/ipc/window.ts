import { BrowserWindow, ipcMain } from 'electron'
import { ensureTray } from '../services/behavior'

/** Frameless-window controls used by the custom title bar. */
export function registerWindowIpc(): void {
  ipcMain.handle('window:minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })
  ipcMain.handle('window:toggleMaximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('window:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })
  ipcMain.handle('window:hideToTray', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    win.hide()
    void ensureTray()
  })
  ipcMain.handle('window:isMaximized', (e) => {
    return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false
  })
}
