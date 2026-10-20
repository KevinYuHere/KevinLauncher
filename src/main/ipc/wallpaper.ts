import { dialog, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { basename, join } from 'path'
import type { AppEntry, Wallpaper, WallpaperSettings } from '@shared/types'
import { DEFAULT_WALLPAPER_SETTINGS } from '@shared/types'
import { advanceIndex, stepIndex } from '@shared/wallpaper'
import { AppStore } from '../services/appStore'
import { applyAutoTheme } from '../services/accent'
import { BgStore } from '../services/background'
import { log } from '../services/logger'
import { openViewer } from '../services/viewer'
import { notifyAppsChanged } from './context'
import { getDesktopWallpaper } from './util'

function requireApp(store: Awaited<ReturnType<typeof AppStore.load>>, appId: string): AppEntry {
  const entry = store.apps.find((a) => a.id === appId)
  if (!entry) throw new Error('应用不存在')
  return entry
}

/** Keeps the shown index in range after list edits. */
function clampIndex(entry: AppEntry): void {
  if (entry.wallpapers.length === 0) entry.wallpaperIndex = 0
  else entry.wallpaperIndex = Math.max(0, Math.min(entry.wallpapers.length - 1, entry.wallpaperIndex))
}

/** Wallpaper lists (add / remove / reorder / rotate) for the picked app. */
export function registerWallpaperIpc(): void {
  // Current Windows desktop wallpaper — used as the background when the
  // launcher has no apps yet.
  ipcMain.handle('wallpaper:desktop', () => getDesktopWallpaper())

  ipcMain.handle('wallpaper:pick', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '图片 / 视频',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'mp4', 'webm', 'm4v', 'mov']
        }
      ]
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('wallpaper:add', async (_e, appId: string, sourcePath: string) => {
    const store = await AppStore.load()
    const entry = requireApp(store, appId)
    entry.wallpapers ??= []
    const wallpaper: Wallpaper = {
      id: randomUUID(),
      file: await BgStore.import(sourcePath),
      name: basename(sourcePath)
    }
    entry.wallpapers.push(wallpaper)
    if (entry.wallpapers.length === 1) entry.wallpaperIndex = 0
    // Use the new wallpaper as the current one and refresh the accent if needed.
    entry.wallpaperIndex = entry.wallpapers.length - 1
    applyAutoTheme(entry)
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    log(`wallpaper: added "${wallpaper.name}" to "${entry.name}"`)
    return entry
  })

  ipcMain.handle('wallpaper:remove', async (_e, appId: string, wallpaperId: string) => {
    const store = await AppStore.load()
    const entry = requireApp(store, appId)
    const index = entry.wallpapers.findIndex((w) => w.id === wallpaperId)
    if (index >= 0) {
      const [removed] = entry.wallpapers.splice(index, 1)
      if (removed) await BgStore.remove(removed.file)
      if (index <= entry.wallpaperIndex) entry.wallpaperIndex -= 1
    }
    // Removing the last wallpaper falls back to the current desktop wallpaper
    // (instead of an empty / black background).
    if (entry.wallpapers.length === 0) {
      const desktop = await getDesktopWallpaper()
      if (desktop) {
        entry.wallpapers.push({
          id: randomUUID(),
          file: await BgStore.import(desktop),
          name: basename(desktop)
        })
      }
    }
    clampIndex(entry)
    applyAutoTheme(entry)
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle('wallpaper:select', async (_e, appId: string, index: number) => {
    const store = await AppStore.load()
    const entry = requireApp(store, appId)
    entry.wallpaperIndex = Math.max(0, Math.min(entry.wallpapers.length - 1, index | 0))
    applyAutoTheme(entry)
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  // Open a wallpaper in the shared media viewer (reuses the gallery viewer,
  // including prev/next navigation and video playback).
  ipcMain.handle('wallpaper:viewer', async (_e, appId: string, index: number) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry || entry.wallpapers.length === 0) return
    const paths = entry.wallpapers.map((w) => join(BgStore.bgDir(), w.file))
    openViewer(paths, index)
  })

  ipcMain.handle('wallpaper:reorder', async (_e, appId: string, ids: string[]) => {
    const store = await AppStore.load()
    const entry = requireApp(store, appId)
    const current = entry.wallpapers.find((w) => w.id === ids[entry.wallpaperIndex])
    const byId = new Map(entry.wallpapers.map((w) => [w.id, w]))
    const ordered = ids.map((id) => byId.get(id)).filter((w): w is Wallpaper => !!w)
    for (const w of entry.wallpapers) if (!ids.includes(w.id)) ordered.push(w)
    entry.wallpapers = ordered
    const nextIndex = current ? entry.wallpapers.findIndex((w) => w.id === current.id) : -1
    entry.wallpaperIndex = nextIndex >= 0 ? nextIndex : 0
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle(
    'wallpaper:settings',
    async (_e, appId: string, patch: Partial<WallpaperSettings>) => {
      const store = await AppStore.load()
      const entry = requireApp(store, appId)
      const base = { ...DEFAULT_WALLPAPER_SETTINGS, ...entry.wallpaperSettings }
      entry.wallpaperSettings = {
        strategy:
          patch.strategy === 'random' || patch.strategy === 'loop' ? patch.strategy : base.strategy,
        trigger:
          patch.trigger === 'launcherStart' ||
          patch.trigger === 'appSwitch' ||
          patch.trigger === 'appLaunch' ||
          patch.trigger === 'interval'
            ? patch.trigger
            : base.trigger,
        intervalMinutes:
          patch.intervalMinutes != null
            ? Math.max(1, Math.min(1440, Math.round(patch.intervalMinutes) || base.intervalMinutes))
            : base.intervalMinutes
      }
      entry.updatedAt = new Date().toISOString()
      await AppStore.save()
      notifyAppsChanged()
      return entry
    }
  )

  ipcMain.handle('wallpaper:step', async (_e, appId: string, delta: number) => {
    const store = await AppStore.load()
    const entry = requireApp(store, appId)
    entry.wallpaperIndex = stepIndex(entry.wallpapers.length, entry.wallpaperIndex, delta || 1)
    applyAutoTheme(entry)
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle('wallpaper:advance', async (_e, appId: string) => {
    const store = await AppStore.load()
    const entry = requireApp(store, appId)
    const strategy = entry.wallpaperSettings?.strategy ?? 'loop'
    entry.wallpaperIndex = advanceIndex(entry.wallpapers.length, entry.wallpaperIndex, strategy)
    applyAutoTheme(entry)
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle('wallpaper:reset', async (_e, appId: string) => {
    const store = await AppStore.load()
    const entry = requireApp(store, appId)
    for (const w of entry.wallpapers) await BgStore.remove(w.file)
    entry.wallpapers = []
    const wallpaper = await getDesktopWallpaper()
    if (wallpaper) {
      entry.wallpapers.push({ id: randomUUID(), file: await BgStore.import(wallpaper), name: basename(wallpaper) })
    }
    entry.wallpaperIndex = 0
    applyAutoTheme(entry)
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })
}
