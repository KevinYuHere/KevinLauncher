import { BrowserWindow, dialog } from 'electron'
import { handleIpc } from './access'
import type { GachaGame, GachaUpdateResult } from '@shared/types'
import { AppStore, requireApp } from '../services/appStore'
import { writeFileAtomic } from '../services/atomicFile'
import { TokenStore } from '../services/tokenStore'
import { log } from '../services/logger'
import { syncMiHoYoGacha } from '../gacha/mihoyo'
import { ArknightsAuthError, fetchArknightsGacha } from '../gacha/arknights'
import { readGachaArchive } from '../gacha/gachaFiles'
import { cancelHypergryphLogin, loginHypergryphToken, silentHypergryphToken } from '../gacha/hypergryphAuth'
import { scanWebCache } from '../gacha/urlSource'
import { gameInstallDirectory } from '../services/gameInstallDirectory'
import { broadcast, gacha } from './context'
import { errorText } from './util'

const fetching = new Map<string, AbortController>()
const tokens = new TokenStore()

async function requireGame(appId: string, expected?: GachaGame) {
  const entry = requireApp(await AppStore.load(), appId)
  if (!entry.addonId) throw new Error('请先为这个应用绑定游戏模块，再获取抽卡记录')
  if (expected && expected !== entry.addonId) throw new Error('这个应用绑定的游戏已变更，请重新打开抽卡记录')
  return { ...entry, addonId: entry.addonId }
}

export function cancelGachaFetches(): void {
  for (const controller of fetching.values()) controller.abort(new Error('启动器正在关闭'))
  cancelHypergryphLogin()
}

async function withFetch(appId: string, fetchAndSave: (signal: AbortSignal) => Promise<GachaUpdateResult>): Promise<GachaUpdateResult> {
  if (fetching.has(appId)) throw new Error('这个应用正在获取抽卡记录，请稍候')
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
      throw new Error('卡池列表已过期，请重新打开抽卡记录')
    }
    return gacha.page(appId, group, showSecond, offset)
  })
  handleIpc('gacha:clear', async (_e, appId: string) => {
    await requireGame(appId)
    if (fetching.has(appId)) throw new Error('正在获取抽卡记录，请稍候')
    await gacha.clear(appId)
    broadcast('gacha:changed', appId)
  })

  handleIpc('gacha:updateMiHoYo', async (_e, appId: string, url: string, mode?: unknown) => {
    const entry = await requireGame(appId)
    if (entry.addonId === 'arknights') throw new Error('这个应用不是米哈游游戏，无法同步抽卡记录')
    if (mode !== undefined && mode !== 'incremental' && mode !== 'full') {
      throw new Error('抽卡同步方式无效，请刷新后重试')
    }
    const syncMode = mode ?? 'incremental'
    const game = entry.addonId
    return withFetch(appId, async (signal) => {
      const checkpoints = syncMode === 'incremental' ? await gacha.checkpoints(appId, game) : []
      const result = await syncMiHoYoGacha(game, url, appId, {
        mode: syncMode,
        checkpoints,
        onProgress: (info) => broadcast('gacha:progress', { appId, phase: 'fetching', ...info }),
        cancellation: signal
      })
      await requireGame(appId, game)
      signal.throwIfAborted()
      const added = await gacha.addWithSync(appId, result.records, result.checkpoints)
      log(`gacha: ${game} +${added} (fetched ${result.records.length}, ${result.mode}, ${result.pages} pages)`)
      broadcast('gacha:changed', appId)
      const total = await gacha.count(appId, game)
      const summary = result.mode === 'full' ? '全量同步完成' : '增量同步完成'
      const boundary = result.earlyStopped ? '（已到可信边界，即上次同步到的位置）' : ''
      return { added, total, message: `${summary}：新增 ${added} 条，共 ${total} 条${boundary}` }
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
        return { ...result, message: `记录已更新，但保存登录状态失败：${errorText(error)}` }
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
      title: '导出抽卡记录',
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
      title: '导入抽卡记录',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    if (fetching.has(appId)) throw new Error('正在获取抽卡记录，请稍候')
    const records = await readGachaArchive(result.filePaths[0], appId, entry.addonId)
    await requireGame(appId, entry.addonId)
    const added = await gacha.add(appId, records)
    broadcast('gacha:changed', appId)
    return added
  })
}
