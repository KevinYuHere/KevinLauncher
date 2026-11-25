import { BrowserWindow, dialog } from 'electron'
import { handleIpc } from './access'
import type { GachaGame, GachaUpdateResult } from '@shared/types'
import { AppStore, requireApp } from '../services/appStore'
import { writeFileAtomic } from '../services/atomicFile'
import { TokenStore } from '../services/tokenStore'
import { log } from '../services/logger'
import { fetchMiHoYoGacha } from '../gacha/mihoyo'
import { ArknightsAuthError, fetchArknightsGacha } from '../gacha/arknights'
import { readGachaArchive } from '../gacha/gachaFiles'
import { cancelHypergryphLogin, loginHypergryphToken, silentHypergryphToken } from '../gacha/hypergryphAuth'
import { scanWebCache } from '../gacha/urlSource'
import { gameInstallDirectory } from '../services/gameInstallDirectory'
import { broadcast, gacha } from './context'

const fetching = new Map<string, AbortController>()
const tokens = new TokenStore()

async function requireGame(appId: string, expected?: GachaGame) {
  const entry = requireApp(await AppStore.load(), appId)
  if (!entry.addonId) throw new Error('请先绑定游戏')
  if (expected && expected !== entry.addonId) throw new Error('应用绑定的游戏已变更，请重新操作')
  return { ...entry, addonId: entry.addonId }
}

export function cancelGachaFetches(): void {
  for (const controller of fetching.values()) controller.abort(new Error('启动器正在关闭'))
  cancelHypergryphLogin()
}

async function withFetch(appId: string, fetchAndSave: (signal: AbortSignal) => Promise<GachaUpdateResult>): Promise<GachaUpdateResult> {
  if (fetching.has(appId)) throw new Error('此应用正在获取抽卡记录')
  const controller = new AbortController()
  fetching.set(appId, controller)
  try {
    broadcast('gacha:progress', { appId, phase: 'fetching' })
    return await fetchAndSave(controller.signal)
  } finally {
    fetching.delete(appId)
    broadcast('gacha:progress', { appId, phase: 'done' })
  }
}

export function registerGachaIpc(): void {
  handleIpc('gacha:stats', async (_e, appId: string) => {
    const entry = await requireGame(appId)
    return gacha.stats(appId, entry.addonId)
  })
  handleIpc('gacha:page', async (_e, appId: string, group: string, showSecond: boolean, offset: number) => {
    const entry = await requireGame(appId)
    if (typeof group !== 'string' || !group.startsWith(`[${JSON.stringify(entry.addonId)},`)) {
      throw new Error('该卡池查询已失效，请重新打开抽卡记录')
    }
    return gacha.page(appId, group, showSecond, offset)
  })
  handleIpc('gacha:clear', async (_e, appId: string) => {
    await requireGame(appId)
    if (fetching.has(appId)) throw new Error('请等待获取记录完成')
    await gacha.clear(appId)
    broadcast('gacha:changed', appId)
  })

  handleIpc('gacha:updateMiHoYo', async (_e, appId: string, url: string) => {
    const entry = await requireGame(appId)
    if (entry.addonId === 'arknights') throw new Error('该应用不是米哈游游戏')
    const game = entry.addonId
    return withFetch(appId, async (signal) => {
      const records = await fetchMiHoYoGacha(game, url, appId,
        (info) => broadcast('gacha:progress', { appId, phase: 'fetching', ...info }), signal)
      await requireGame(appId, game)
      signal.throwIfAborted()
      const added = await gacha.add(appId, records)
      log(`gacha: ${game} +${added} (fetched ${records.length})`)
      broadcast('gacha:changed', appId)
      return { added, total: await gacha.count(appId, game) }
    })
  })

  handleIpc('gacha:loginArknights', (e, appId: string) => withFetch(appId, async (signal) => {
    await requireGame(appId, 'arknights')
    const key = `arknights:${appId}`

    const run = async (token: string): Promise<GachaUpdateResult> => {
      const records = await fetchArknightsGacha(token, appId, signal)
      await requireGame(appId, 'arknights')
      signal.throwIfAborted()
      const added = await gacha.add(appId, records)
      log(`gacha: arknights +${added} (fetched ${records.length})`)
      broadcast('gacha:changed', appId)
      return { added, total: await gacha.count(appId, 'arknights') }
    }

    const remember = async (token: string, result: GachaUpdateResult): Promise<GachaUpdateResult> => {
      try {
        await tokens.set(key, token)
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ...result, message: `记录已更新，保存登录状态失败：${message}` }
      }
    }

    // 1) reuse the cached token if it still works
    const cached = await tokens.get(key)
    if (cached) {
      try {
        return await run(cached)
      } catch (error) {
        if (!(error instanceof ArknightsAuthError)) throw error
        log(`gacha: cached login rejected (${error.message})`)
        await tokens.remove(key, cached)
      }
    }

    // 2) silently refresh from the persisted login session
    const silent = await silentHypergryphToken()
    signal.throwIfAborted()
    if (silent) {
      try {
        return await remember(silent, await run(silent))
      } catch (error) {
        if (!(error instanceof ArknightsAuthError)) throw error
      }
    }

    // 3) ask the user to log in
    const token = await loginHypergryphToken(BrowserWindow.fromWebContents(e.sender))
    signal.throwIfAborted()
    return remember(token, await run(token))
  }))

  handleIpc('gacha:scanUrl', async (_e, appId: string) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry?.addonId || entry.addonId === 'arknights') return null
    const gameDir = gameInstallDirectory(entry)
    return gameDir ? scanWebCache(gameDir, entry.addonId) : null
  })

  handleIpc('gacha:export', async (_e, appId: string) => {
    const entry = await requireGame(appId)
    const archive = await gacha.exportArchive(appId)
    const name = entry.name.replace(/[\\/:*?"<>|]/g, '_')
    const result = await dialog.showSaveDialog({
      defaultPath: `gacha-${name}.${archive.format === 'uigf' ? 'uigf' : 'kl-gacha'}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeFileAtomic(result.filePath, archive.text)
    return { path: result.filePath, format: archive.format }
  })

  handleIpc('gacha:import', async (_e, appId: string) => {
    const entry = await requireGame(appId)
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    if (fetching.has(appId)) throw new Error('请等待获取记录完成')
    const records = await readGachaArchive(result.filePaths[0], appId, entry.addonId)
    await requireGame(appId, entry.addonId)
    const added = await gacha.add(appId, records)
    broadcast('gacha:changed', appId)
    return added
  })
}
