import { dialog } from 'electron'
import { handleIpc } from './access'
import { randomUUID } from 'crypto'
import { basename, join } from 'path'
import type { AppEntry, WallpaperSettings } from '@shared/types'
import { DEFAULT_WALLPAPER_SETTINGS } from '@shared/types'
import { advanceIndex, stepIndex } from '@shared/wallpaper'
import { currentWallpaper } from '@shared/appEntry'
import { AppStore } from '../services/appStore'
import { applyAutoTheme } from '../services/accent'
import { BgStore } from '../services/background'
import { openViewer } from '../services/viewer'
import { rememberSelectedFiles } from '../services/mediaAccess'
import { notifyAppsChanged } from './context'
import { getDesktopWallpaper } from './util'

async function changeWallpaper(appId: string, change: (entry: AppEntry) => void | Promise<void>): Promise<AppEntry> {
  const entry = await AppStore.mutateApp(appId, change)
  notifyAppsChanged()
  return entry
}

async function addDesktopWallpaper(entry: AppEntry): Promise<void> {
  const source = await getDesktopWallpaper()
  if (source) {
    entry.wallpapers.push({ id: randomUUID(), file: await BgStore.import(source), name: basename(source) })
  }
}

function selectWallpaper(entry: AppEntry, id: string | undefined, fallback = 0): void {
  const index = entry.wallpapers.findIndex((wallpaper) => wallpaper.id === id)
  entry.wallpaperIndex = index >= 0 ? index : Math.max(0, Math.min(entry.wallpapers.length - 1, fallback))
}

/** Wallpaper lists (add / remove / reorder / rotate) for the picked app. */
export function registerWallpaperIpc(): void {
  handleIpc('wallpaper:desktop', () => getDesktopWallpaper())

  handleIpc('wallpaper:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择壁纸',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '图片或视频',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'mp4', 'webm', 'm4v', 'mov']
        }
      ]
    })
    const paths = result.canceled ? [] : result.filePaths
    rememberSelectedFiles(paths)
    return paths
  })

  handleIpc('wallpaper:add', (_e, appId: string, sourcePath: string) =>
    changeWallpaper(appId, async (entry) => {
      entry.wallpapers.push({ id: randomUUID(), file: await BgStore.import(sourcePath), name: basename(sourcePath) })
      entry.wallpaperIndex = entry.wallpapers.length - 1
      await applyAutoTheme(entry)
    })
  )

  handleIpc('wallpaper:remove', (_e, appId: string, wallpaperId: string) =>
    changeWallpaper(appId, async (entry) => {
      const index = entry.wallpapers.findIndex((wallpaper) => wallpaper.id === wallpaperId)
      if (index < 0) return
      const currentId = currentWallpaper(entry)?.id
      entry.wallpapers.splice(index, 1)
      if (entry.wallpapers.length === 0) await addDesktopWallpaper(entry)
      selectWallpaper(entry, currentId, index - 1)
      await applyAutoTheme(entry)
    })
  )

  handleIpc('wallpaper:select', (_e, appId: string, index: number) =>
    changeWallpaper(appId, async (entry) => {
      selectWallpaper(entry, undefined, index)
      await applyAutoTheme(entry)
    })
  )

  handleIpc('wallpaper:viewer', async (_e, appId: string, index: number) => {
    const store = await AppStore.load()
    const entry = store.apps.find((item) => item.id === appId)
    if (!entry || entry.wallpapers.length === 0) return
    openViewer(entry.wallpapers.map((wallpaper) => join(BgStore.bgDir(), wallpaper.file)), index)
  })

  handleIpc('wallpaper:reorder', async (_e, appId: string, ids: string[]) => {
    const entry = await AppStore.reorderWallpapers(appId, ids)
    notifyAppsChanged()
    return entry
  })

  handleIpc('wallpaper:settings', (_e, appId: string, patch: Partial<WallpaperSettings>) =>
    changeWallpaper(appId, (entry) => {
      const settings = { ...DEFAULT_WALLPAPER_SETTINGS, ...entry.wallpaperSettings, ...patch }
      settings.intervalMinutes = Math.max(1, Math.min(1440, Math.round(settings.intervalMinutes)))
      entry.wallpaperSettings = settings
    })
  )

  handleIpc('wallpaper:step', (_e, appId: string, delta: number) =>
    changeWallpaper(appId, async (entry) => {
      entry.wallpaperIndex = stepIndex(entry.wallpapers.length, entry.wallpaperIndex, delta || 1)
      await applyAutoTheme(entry)
    })
  )

  handleIpc('wallpaper:advance', (_e, appId: string) =>
    changeWallpaper(appId, async (entry) => {
      if (entry.wallpapers.length < 2) return
      entry.wallpaperIndex = advanceIndex(entry.wallpapers.length, entry.wallpaperIndex, entry.wallpaperSettings.strategy)
      await applyAutoTheme(entry)
    })
  )

  handleIpc('wallpaper:reset', (_e, appId: string) =>
    changeWallpaper(appId, async (entry) => {
      entry.wallpapers = []
      await addDesktopWallpaper(entry)
      entry.wallpaperIndex = 0
      await applyAutoTheme(entry)
    })
  )
}
