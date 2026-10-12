import { dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'fs'
import { extname } from 'path'
import { currentAppVersion } from '../services/appVersion'
import { iconDataFromPath, imageDataUrl } from './util'

export function registerMediaIpc(): void {
  ipcMain.handle('image:read', async (_e, path: string) => {
    try {
      return imageDataUrl(await fs.readFile(path), extname(path))
    } catch {
      return null
    }
  })

  ipcMain.handle('image:iconFromPath', (_e, path: string) => iconDataFromPath(path))

  ipcMain.handle('app:version', () => currentAppVersion())

  ipcMain.handle('dialog:pickExecutable', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: '可执行文件 / 脚本', extensions: ['exe', 'bat', 'cmd', 'ps1', 'lnk'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:pickBackground', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: '图片 / 视频', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp4', 'webm'] }
      ]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:pickImage', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Icon source: an image, or an exe/bat/cmd/ps1/lnk whose icon we extract.
  ipcMain.handle('dialog:pickIconSource', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        {
          name: '图片 / 可执行文件 / 快捷方式',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'exe', 'bat', 'cmd', 'ps1', 'lnk']
        },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    const dataUrl = await iconDataFromPath(path)
    return dataUrl ? { path, dataUrl } : null
  })

  ipcMain.handle('dialog:pickDirectory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('shell:openPath', async (_e, path: string) => {
    await shell.openPath(path)
  })

  // Only http(s) links may be opened externally (never file:// or custom schemes).
  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })
}
