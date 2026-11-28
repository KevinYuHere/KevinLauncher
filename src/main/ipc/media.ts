import { app, BrowserWindow, dialog, shell, type WebContents } from 'electron'
import { handleIpc } from './access'
import { promises as fs } from 'fs'
import { dirname, extname } from 'path'
import type { FeatureIntro } from '@shared/types'
import { currentAppVersion } from '../services/appVersion'
import { confirmApplicationActivation } from '../services/appActivation'
import { applyUpgradeFeaturesOnReady, completeUpgradeIntro } from '../services/themePolicy'
import { iconDataFromPath, imageDataUrl } from './util'
import { appUpdate, broadcast } from './context'
import { syncInstalledVersion } from '../services/install'
import {
  isAllowedMediaRead,
  isImageMediaPath,
  isSelectedFile,
  rememberSelectedDirectory,
  rememberSelectedFile,
  resolveShellOpenTarget
} from '../services/mediaAccess'
import { managedMediaRoots } from '../services/mediaRoots'

const MAX_IMAGE_READ = 64 * 1024 * 1024

export function registerMediaIpc(): void {
  handleIpc('image:read', async (_e, path: string) => {
    if (typeof path !== 'string' || !isImageMediaPath(path)) return null
    if (!isAllowedMediaRead(path, managedMediaRoots())) return null
    try {
      const info = await fs.stat(path)
      if (!info.isFile() || info.size > MAX_IMAGE_READ) return null
      return imageDataUrl(await fs.readFile(path), extname(path))
    } catch {
      return null
    }
  })

  handleIpc('image:iconFromPath', (_e, path: string) => {
    if (typeof path !== 'string') return null
    if (!isSelectedFile(path) && !isAllowedMediaRead(path, managedMediaRoots())) return null
    return iconDataFromPath(path)
  })

  handleIpc('app:version', () => currentAppVersion())
  let activation: Promise<void> | undefined
  const confirmReady = (): Promise<void> => {
    activation ??= confirmApplicationActivation().then(async () => {
      if (app.isPackaged) await syncInstalledVersion(dirname(process.execPath), currentAppVersion())
      await appUpdate.cleanupOldVersions()
    }).catch(error => {
      activation = undefined
      throw error
    })
    return activation
  }
  handleIpc('app:ready', confirmReady)

  /** A visible main window accepts the queued one-time actions. */
  const mainWindowVisible = (sender: WebContents): boolean => {
    const win = BrowserWindow.fromWebContents(sender)
    return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()
  }
  let featureTask: Promise<FeatureIntro | null> | undefined
  let deliveredIntroVersion: string | null = null
  handleIpc('app:upgradeFeatures', async (e) => {
    if (!mainWindowVisible(e.sender)) return null
    try {
      await confirmReady()
    } catch {
      return null
    }
    featureTask ??= (async () => {
      const result = await applyUpgradeFeaturesOnReady()
      if (result.changed) {
        broadcast('apps:changed')
        broadcast('launcher:changed')
      }
      if (result.intro) deliveredIntroVersion = currentAppVersion()
      return result.intro
    })().finally(() => {
      featureTask = undefined
    })
    return featureTask
  })
  handleIpc('app:completeUpgradeIntro', async (e) => {
    if (!mainWindowVisible(e.sender)) return false
    try {
      await confirmReady()
    } catch {
      return false
    }
    // Only a renderer of this same process that was actually handed the
    // introduction may record it as completed.
    if (deliveredIntroVersion !== currentAppVersion()) return false
    const marked = await completeUpgradeIntro()
    deliveredIntroVersion = null
    return marked
  })

  handleIpc('dialog:pickExecutable', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择要启动的程序、脚本或快捷方式',
      properties: ['openFile'],
      filters: [
        { name: '程序、脚本或快捷方式', extensions: ['exe', 'bat', 'cmd', 'ps1', 'lnk'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePaths[0]) return null
    rememberSelectedFile(result.filePaths[0])
    return result.filePaths[0]
  })

  handleIpc('dialog:pickBackground', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择背景图片或视频',
      properties: ['openFile'],
      filters: [
        { name: '图片或视频', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp4', 'webm'] }
      ]
    })
    if (result.canceled || !result.filePaths[0]) return null
    rememberSelectedFile(result.filePaths[0])
    return result.filePaths[0]
  })

  handleIpc('dialog:pickImage', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    rememberSelectedFile(result.filePaths[0])
    return result.filePaths[0]
  })

  // Icon source: an image, or an exe/bat/cmd/ps1/lnk whose icon we extract.
  handleIpc('dialog:pickIconSource', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择图标来源',
      properties: ['openFile'],
      filters: [
        {
          name: '图片、程序或快捷方式',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'exe', 'bat', 'cmd', 'ps1', 'lnk']
        },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    rememberSelectedFile(path)
    const dataUrl = await iconDataFromPath(path)
    return dataUrl ? { path, dataUrl } : null
  })

  handleIpc('dialog:pickDirectory', async () => {
    const result = await dialog.showOpenDialog({ title: '选择文件夹', properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    rememberSelectedDirectory(result.filePaths[0])
    return result.filePaths[0]
  })

  handleIpc('shell:openPath', async (_e, path: string) => {
    const target = await resolveShellOpenTarget(path)
    const failure = await shell.openPath(target.path)
    if (failure) throw new Error(target.kind === 'directory'
      ? '无法打开该文件夹，请确认它仍在原位置'
      : '无法打开该媒体文件，请确认它仍在原位置')
  })

  // Only http(s) links may be opened externally (never file:// or custom schemes).
  handleIpc('shell:openExternal', async (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })
}
