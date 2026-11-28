import { handleIpc } from './access'
import { gameInstallDirectory } from '../services/gameInstallDirectory'
import { AppStore } from '../services/appStore'
import { currentAppVersion } from '../services/appVersion'
import { getHoYoUpdateInfo } from '../update/hoyoplay'
import { withHoYoNetwork } from '../update/hoyoNetwork'
import { app } from 'electron'
import { getArknightsUpdateInfo } from '../update/arknightsUpdate'
import { getUpdatePreview, updates } from './context'
import { trialBuild } from '../services/buildIdentity'

export function registerUpdateIpc(): void {
  handleIpc('update:info', async (_e, appId: string) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry) throw new Error('应用不存在，可能已被移除')
    const preview = trialBuild ? getUpdatePreview(appId) : undefined
    if (trialBuild && entry.addonId) {
      return {
        game: entry.addonId,
        currentVersion: null,
        latestVersion: preview?.hasUpdate ? '9.9.9' : null,
        preDownloadVersion: preview?.preDownloadVersion ?? null,
        hasUpdate: preview?.hasUpdate === true,
        supported: !!preview,
        mainSizeBytes: 0,
        preDownloadSizeBytes: 0,
        message: preview ? '本地模拟更新（不会下载真实游戏文件）' : '本地试用版不会连接真实游戏更新服务器'
      }
    }
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
        message: '这个应用还没有绑定游戏模块，无法检查或更新游戏'
      }
    }
    const gameDir = gameInstallDirectory(entry)
    const game = entry.addonId
    const info =
      game === 'arknights'
        ? await getArknightsUpdateInfo(gameDir)
        : await withHoYoNetwork(app.getPath('userData'), 'desktop',
            () => getHoYoUpdateInfo(game, gameDir), currentAppVersion())
    return info
  })

  handleIpc('update:start', async (_e, appId: string, mode: 'update' | 'preDownload') => {
    // Preview mode: fake the download instead of hitting the real servers.
    const preview = trialBuild ? getUpdatePreview(appId) : undefined
    if (preview) {
      updates.simulate(appId, mode, mode === 'preDownload' ? preview.stopAt : undefined)
      return
    }
    if (trialBuild) throw new Error('本地试用版不会连接真实游戏更新服务器')
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry?.addonId) throw new Error('这个应用还没有绑定游戏模块，无法检查或更新游戏')
    await updates.start(appId, mode, entry.addonId, gameInstallDirectory(entry))
  })

  handleIpc('update:cancel', (_e, appId: string) => updates.cancel(appId))
  handleIpc('update:status', (_e, appId: string) => updates.status(appId))
}
