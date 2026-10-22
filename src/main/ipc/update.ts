import { ipcMain } from 'electron'
import { dirname } from 'path'
import type { AppEntry } from '@shared/types'
import { defaultLaunchMethod } from '@shared/appEntry'
import { AppStore } from '../services/appStore'
import { getHoYoUpdateInfo } from '../update/hoyoplay'
import { getArknightsUpdateInfo } from '../update/arknightsUpdate'
import { getUpdatePreview, updates } from './context'

/** Resolve an app's game directory (falls back to the default method's folder). */
function gameDirOf(entry: AppEntry): string {
  return entry.gameDirectory?.trim() || dirname(defaultLaunchMethod(entry)?.targetPath ?? '')
}

export function registerUpdateIpc(): void {
  ipcMain.handle('update:info', async (_e, appId: string) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry) throw new Error('应用不存在')
    // Plain apps have no game module — report "unsupported" instead of throwing.
    if (!entry.addonId) {
      return {
        game: 'genshin',
        currentVersion: null,
        latestVersion: null,
        preDownloadVersion: null,
        hasUpdate: false,
        supported: false,
        mainSizeBytes: 0,
        preDownloadSizeBytes: 0,
        message: '该应用未绑定游戏模块'
      }
    }
    const gameDir = gameDirOf(entry)
    const info =
      entry.addonId === 'arknights'
        ? await getArknightsUpdateInfo(gameDir)
        : await getHoYoUpdateInfo(entry.addonId, gameDir)
    const preview = getUpdatePreview(appId)
    if (preview) {
      info.supported = true
      if (preview.hasUpdate) {
        info.hasUpdate = true
        info.latestVersion = '9.9.9'
        info.message = '发现新版本 9.9.9'
      }
      if (preview.preDownloadVersion) {
        info.preDownloadVersion = preview.preDownloadVersion
        info.message = info.hasUpdate
          ? `发现新版本 9.9.9 · 可预下载 ${preview.preDownloadVersion}`
          : `可预下载 ${preview.preDownloadVersion}`
      }
    }
    return info
  })

  ipcMain.handle('update:start', async (_e, appId: string, mode: 'update' | 'preDownload') => {
    // Preview mode: fake the download instead of hitting the real servers.
    const preview = getUpdatePreview(appId)
    if (preview) {
      updates.simulate(appId, mode, mode === 'preDownload' ? preview.stopAt : undefined)
      return
    }
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry?.addonId) throw new Error('该应用未绑定游戏模块')
    await updates.start(appId, mode, entry.addonId, gameDirOf(entry))
  })

  ipcMain.handle('update:cancel', (_e, appId: string) => updates.cancel(appId))
  ipcMain.handle('update:status', (_e, appId: string) => updates.status(appId))
  ipcMain.handle('update:simulate', (_e, appId: string, mode: 'update' | 'preDownload') =>
    updates.simulate(appId, mode)
  )
}
