import { BrowserWindow, dialog, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { dirname } from 'path'
import { AppStore } from '../services/appStore'
import { TokenStore } from '../services/tokenStore'
import { log } from '../services/logger'
import { fetchMiHoYoGacha } from '../gacha/mihoyo'
import { fetchArknightsGacha } from '../gacha/arknights'
import { loginHypergryphToken, silentHypergryphToken } from '../gacha/hypergryphAuth'
import { scanWebCache } from '../gacha/urlSource'
import { broadcast, gacha } from './context'

export function registerGachaIpc(): void {
  ipcMain.handle('gacha:list', async (_e, appId: string) => gacha.list(appId))
  ipcMain.handle('gacha:stats', async (_e, appId: string) => gacha.stats(appId))
  ipcMain.handle('gacha:clear', async (_e, appId: string) => gacha.clear(appId))

  ipcMain.handle('gacha:updateMiHoYo', async (_e, appId: string, url: string) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry?.addonId || entry.addonId === 'arknights') throw new Error('该应用不是米哈游游戏')
    try {
      const records = await fetchMiHoYoGacha(entry.addonId, url, appId, (info) =>
        broadcast('gacha:progress', { appId, phase: 'fetching', ...info })
      )
      const added = await gacha.add(appId, records)
      log(`gacha: ${entry.addonId} +${added} (fetched ${records.length})`)
      return { added, total: (await gacha.list(appId)).length }
    } finally {
      broadcast('gacha:progress', { appId, phase: 'done' })
    }
  })

  ipcMain.handle('gacha:loginArknights', async (e, appId: string) => {
    const key = `arknights:${appId}`
    const store = new TokenStore()

    const run = async (token: string): Promise<{ added: number; total: number }> => {
      const records = await fetchArknightsGacha(token, appId)
      const added = await gacha.add(appId, records)
      log(`gacha: arknights +${added} (fetched ${records.length})`)
      return { added, total: (await gacha.list(appId)).length }
    }

    // 1) reuse the cached token if it still works
    const cached = await store.get(key)
    if (cached) {
      try {
        return await run(cached)
      } catch (error) {
        const message = (error as Error).message
        log(`gacha: cached token failed (${message})`)
        if (!/token|登录|授权|绑定|角色/i.test(message)) throw error
        await store.remove(key)
      }
    }

    // 2) silently refresh from the persisted login session
    const silent = await silentHypergryphToken()
    if (silent) {
      try {
        const result = await run(silent)
        await store.set(key, silent)
        return result
      } catch {
        /* fall through to interactive login */
      }
    }

    // 3) ask the user to log in
    const token = await loginHypergryphToken(BrowserWindow.fromWebContents(e.sender))
    await store.set(key, token)
    return run(token)
  })

  ipcMain.handle('gacha:scanUrl', async (_e, appId: string) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry?.addonId || entry.addonId === 'arknights') return null
    // The launch target may be a script/shortcut; the game's web cache lives
    // under the configured game directory.
    const gameDir = entry.gameDirectory?.trim() || dirname(entry.targetPath)
    return scanWebCache(gameDir, entry.addonId)
  })

  ipcMain.handle('gacha:export', async (_e, appId: string) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    const json = await gacha.exportUigf(appId, entry?.name ?? appId)
    const result = await dialog.showSaveDialog({
      defaultPath: `gacha-${entry?.name ?? appId}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null
    await fs.writeFile(result.filePath, json, 'utf-8')
    return result.filePath
  })

  ipcMain.handle('gacha:import', async (_e, appId: string) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return 0
    const raw = await fs.readFile(result.filePaths[0], 'utf-8')
    return gacha.importRecords(appId, raw)
  })
}
