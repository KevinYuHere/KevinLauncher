import { app, dialog, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { copyFile } from 'fs/promises'
import { basename, join } from 'path'
import {
  DEFAULT_GLASS_APPEARANCE,
  DEFAULT_HOME_MODULE,
  DEFAULT_WALLPAPER_SETTINGS,
  HOME_MODULES,
  LAUNCH_EFFECTS,
  type AppEntry,
  type GlassMaterial,
  type GlassPatch,
  type HomeModuleId,
  type HomeModuleState,
  type LaunchEffect,
  type LaunchMethod,
  type NewAppEntry
} from '@shared/types'
import { currentWallpaper, defaultLaunchMethod, isVideoFile } from '@shared/appEntry'
import { ADDONS } from '../addons/registry'
import { AppStore } from '../services/appStore'
import { applyAutoTheme } from '../services/accent'
import { BgStore } from '../services/background'
import { BrandStore } from '../services/brand'
import { IconStore } from '../services/icon'
import { applyAutoStart } from '../services/autostart'
import { applyLauncherIcon } from '../services/appIcon'
import { setCloseToTray } from '../services/behavior'
import { extractAccent } from '../services/theme'
import { log } from '../services/logger'
import { broadcast, notifyAppsChanged } from './context'
import { decodeDataUrl, getDesktopWallpaper } from './util'


function requireApp(store: Awaited<ReturnType<typeof AppStore.load>>, appId: string): AppEntry {
  const entry = store.apps.find((a) => a.id === appId)
  if (!entry) throw new Error('应用不存在')
  return entry
}

const GLASS_MATERIALS: readonly GlassMaterial[] = ['blur', 'mica', 'liquid', 'shine']

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.round(value) || 0))

/** Merge a patch over the (default-filled) current glass appearance, clamping. */
function mergeGlass(current: Partial<AppEntry['glass']> | undefined, patch: GlassPatch): AppEntry['glass'] {
  const base = { ...DEFAULT_GLASS_APPEARANCE, ...current }
  const pick = (v: number | undefined, lo: number, hi: number, fallback: number): number =>
    v != null ? clamp(v, lo, hi) : fallback
  return {
    brightness: pick(patch.brightness, 0, 100, base.brightness),
    opacity: pick(patch.opacity, 0, 100, base.opacity),
    material:
      patch.material && GLASS_MATERIALS.includes(patch.material) ? patch.material : base.material,
    blur: pick(patch.blur, 0, 60, base.blur),
    saturation: pick(patch.saturation, 50, 200, base.saturation),
    grain: pick(patch.grain, 0, 100, base.grain),
    refraction: pick(patch.refraction, 0, 200, base.refraction),
    panelRefraction: pick(patch.panelRefraction, 0, 200, base.panelRefraction),
    edgeWidth: pick(patch.edgeWidth, 4, 100, base.edgeWidth),
    highlight: pick(patch.highlight, 0, 100, base.highlight),
    highlightAngle: pick(patch.highlightAngle, 0, 360, base.highlightAngle),
    dispersion: pick(patch.dispersion, 0, 100, base.dispersion)
  }
}

export function registerAppsIpc(): void {
  // Export the launcher logs to a user-chosen directory (for support).
  ipcMain.handle('logs:export', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择导出日志的目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || filePaths.length === 0) return null
    const dir = app.getPath('userData')
    const target = filePaths[0]
    let copied = 0
    for (const name of ['launcher.log', 'launcher.log.1']) {
      try {
        await copyFile(join(dir, name), join(target, name))
        copied++
      } catch {
        /* no such log file */
      }
    }
    return copied > 0 ? target : null
  })

  ipcMain.handle('addons:list', () => ADDONS)

  ipcMain.handle('apps:list', async () => (await AppStore.load()).apps)

  ipcMain.handle('apps:add', async (_e, input: NewAppEntry) => {
    const store = await AppStore.load()
    const now = new Date().toISOString()

    const methods: LaunchMethod[] = (input.launchMethods ?? []).map((m, index) => ({
      id: randomUUID(),
      name: m.name?.trim() || (index === 0 ? '默认' : `启动方式 ${index + 1}`),
      targetPath: (m.targetPath ?? '').trim(),
      arguments: m.arguments ?? '',
      workingDirectory: m.workingDirectory ?? '',
      runAsAdmin: m.runAsAdmin ?? true
    }))
    // An app may be created without any launch file yet (configure it later).
    if (methods.length === 0) {
      methods.push({
        id: randomUUID(),
        name: '默认',
        targetPath: '',
        arguments: '',
        workingDirectory: '',
        runAsAdmin: true
      })
    }

    let iconFile: string | null = null
    if (methods[0].targetPath) {
      try {
        const image = await app.getFileIcon(methods[0].targetPath, { size: 'large' })
        if (!image.isEmpty()) iconFile = await IconStore.savePng(image.toPNG())
      } catch {
        /* icon extraction is best-effort */
      }
    }

    const entry: AppEntry = {
      id: randomUUID(),
      name: input.name?.trim() || '未命名应用',
      moduleLabel: input.moduleLabel?.trim() || null,
      launchMethods: methods,
      defaultLaunchMethodId: methods[0].id,
      gameDirectory: input.gameDirectory ?? null,
      environmentVariables: input.environmentVariables ?? {},
      addonId: input.addonId ?? null,
      iconFile,
      wallpapers: [],
      wallpaperSettings: { ...DEFAULT_WALLPAPER_SETTINGS },
      wallpaperIndex: 0,
      themeColor: null,
      glass: { ...DEFAULT_GLASS_APPEARANCE },
      autoTheme: true,
      backgroundBlur: 0,
      backgroundDim: 25,
      screenshotDirectory: input.screenshotDirectory ?? null,
      monitorProcessNames: input.monitorProcessNames ?? [],
      gachaShowSecond: true,
      linkedLaunchIds: [],
      defaultLinkedLaunchId: null,
      launchEffect: input.launchEffect ?? 'none',
      createdAt: now,
      updatedAt: now
    }
    store.apps.push(entry)

    // Default wallpaper: the current desktop wallpaper.
    try {
      const wallpaper = await getDesktopWallpaper()
      if (wallpaper) {
        entry.wallpapers.push({
          id: randomUUID(),
          file: await BgStore.import(wallpaper),
          name: basename(wallpaper)
        })
      }
    } catch {
      /* ignore */
    }
    applyAutoTheme(entry)

    await AppStore.save()
    log(`apps: added "${entry.name}" (${methods[0].targetPath})`)
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle('apps:update', async (_e, appEntry: AppEntry) => {
    const store = await AppStore.load()
    const index = store.apps.findIndex((a) => a.id === appEntry.id)
    if (index < 0) throw new Error('应用不存在')
    const updated: AppEntry = { ...appEntry, updatedAt: new Date().toISOString() }
    store.apps[index] = updated
    await AppStore.save()
    notifyAppsChanged()
    return updated
  })

  ipcMain.handle('apps:remove', async (_e, id: string) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === id)
    if (entry) for (const wallpaper of entry.wallpapers ?? []) await BgStore.remove(wallpaper.file)
    if (entry?.iconFile) await IconStore.remove(entry.iconFile)
    store.apps = store.apps.filter((a) => a.id !== id)
    await AppStore.save()
    notifyAppsChanged()
  })

  ipcMain.handle('apps:reorder', async (_e, ids: string[]) => {
    const apps = await AppStore.reorder(ids)
    notifyAppsChanged()
    return apps
  })

  ipcMain.handle('ui:getPrefs', () => AppStore.uiPrefs())

  ipcMain.handle('ui:setGamesRowHidden', async (_e, hidden: boolean) => {
    await AppStore.setGamesRowHidden(hidden)
    return AppStore.uiPrefs()
  })

  // ---------------------------------------------------------------- launcher
  ipcMain.handle('launcher:getSettings', () => AppStore.launcherSettings())

  ipcMain.handle('launcher:setIcon', async (_e, dataUrl: string | null) => {
    const current = await AppStore.launcherSettings()
    if (current.iconFile) await BrandStore.remove(current.iconFile)
    let iconFile: string | null = null
    if (dataUrl) {
      const png = decodeDataUrl(dataUrl)
      iconFile = await BrandStore.savePng(png)
      await BrandStore.saveIcoFor(iconFile, png)
    }
    await AppStore.setLauncher({ iconFile })
    // User-initiated: refresh the shell caches immediately (including the Start
    // Menu host, which otherwise keeps showing the old icon until logon).
    await applyLauncherIcon({ refreshShell: true })
    broadcast('launcher:changed')
    return AppStore.launcherSettings()
  })

  ipcMain.handle('launcher:setFont', async (_e, family: string | null) => {
    await AppStore.setLauncher({ fontFamily: family })
    broadcast('launcher:changed')
    return AppStore.launcherSettings()
  })

  ipcMain.handle(
    'launcher:setBehavior',
    async (
      _e,
      patch: {
        closeAction?: 'close' | 'tray'
        afterLaunch?: 'none' | 'minimize' | 'tray' | 'close'
        autoStart?: 'off' | 'window' | 'tray'
        sidebarMaterial?: boolean
        updateChannel?: 'stable' | 'beta'
      }
    ) => {
      await AppStore.setLauncher(patch)
      if (patch.closeAction) setCloseToTray(patch.closeAction === 'tray')
      if (patch.autoStart) applyAutoStart(patch.autoStart)
      broadcast('launcher:changed')
      return AppStore.launcherSettings()
    }
  )

  // -------------------------------------------------------------- appearance
  ipcMain.handle('apps:setIcon', async (_e, appId: string, sourcePath: string | null) => {
    const store = await AppStore.load()
    const entry = requireApp(store, appId)
    if (entry.iconFile) {
      await IconStore.remove(entry.iconFile)
      entry.iconFile = null
    }
    if (sourcePath) entry.iconFile = await IconStore.import(sourcePath)
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle('apps:setIconData', async (_e, appId: string, dataUrl: string | null) => {
    const store = await AppStore.load()
    const entry = requireApp(store, appId)
    if (entry.iconFile) {
      await IconStore.remove(entry.iconFile)
      entry.iconFile = null
    }
    if (dataUrl) entry.iconFile = await IconStore.savePng(decodeDataUrl(dataUrl))
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle('apps:resetIcon', async (_e, appId: string) => {
    const store = await AppStore.load()
    const entry = requireApp(store, appId)
    if (entry.iconFile) {
      await IconStore.remove(entry.iconFile)
      entry.iconFile = null
    }
    const method = defaultLaunchMethod(entry)
    try {
      if (method?.targetPath) {
        const image = await app.getFileIcon(method.targetPath, { size: 'large' })
        if (!image.isEmpty()) entry.iconFile = await IconStore.savePng(image.toPNG())
      }
    } catch {
      /* ignore */
    }
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle('apps:setAutoTheme', async (_e, appId: string, on: boolean) => {
    const store = await AppStore.load()
    const entry = requireApp(store, appId)
    entry.autoTheme = on
    applyAutoTheme(entry)
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle('apps:setThemeColor', async (_e, appId: string, color: string | null) => {
    const store = await AppStore.load()
    const entry = requireApp(store, appId)
    entry.themeColor = color
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle('apps:setGlass', async (_e, appId: string, patch: GlassPatch) => {
    const store = await AppStore.load()
    const entry = requireApp(store, appId)
    entry.glass = mergeGlass(entry.glass, patch)
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle(
    'apps:setBgTuning',
    async (_e, appId: string, tuning: { blur: number; dim: number }) => {
      const store = await AppStore.load()
      const entry = requireApp(store, appId)
      entry.backgroundBlur = Math.max(0, Math.min(60, Math.round(tuning.blur) || 0))
      entry.backgroundDim = Math.max(0, Math.min(100, Math.round(tuning.dim)))
      entry.updatedAt = new Date().toISOString()
      await AppStore.save()
      notifyAppsChanged()
      return entry
    }
  )

  ipcMain.handle('apps:setGachaShowSecond', async (_e, appId: string, value: boolean) => {
    const store = await AppStore.load()
    const entry = requireApp(store, appId)
    entry.gachaShowSecond = !!value
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle(
    'apps:setHomeModule',
    async (_e, appId: string, moduleId: HomeModuleId, patch: Partial<HomeModuleState>) => {
      const store = await AppStore.load()
      const entry = requireApp(store, appId)
      const def = HOME_MODULES.find((m) => m.id === moduleId)
      if (!def) return entry
      const current: HomeModuleState = {
        ...DEFAULT_HOME_MODULE,
        ...(entry.homeModules?.[moduleId] ?? {})
      }
      const next: HomeModuleState = { ...current }
      // The launch button can never be hidden.
      if (patch.visible != null) next.visible = def.hideable ? !!patch.visible : true
      if (patch.draggable != null) next.draggable = !!patch.draggable
      if (patch.x !== undefined) next.x = patch.x == null ? null : Math.max(0, Math.min(1, patch.x))
      if (patch.y !== undefined) next.y = patch.y == null ? null : Math.max(0, Math.min(1, patch.y))
      entry.homeModules = { ...(entry.homeModules ?? {}), [moduleId]: next }
      entry.updatedAt = new Date().toISOString()
      await AppStore.save()
      notifyAppsChanged()
      return entry
    }
  )

  ipcMain.handle('apps:setLaunchEffect', async (_e, appId: string, effect: LaunchEffect) => {
    const store = await AppStore.load()
    const entry = requireApp(store, appId)
    entry.launchEffect = LAUNCH_EFFECTS.some((e) => e.id === effect) ? effect : 'none'
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle('apps:setModuleLabel', async (_e, appId: string, label: string | null) => {
    const store = await AppStore.load()
    const entry = requireApp(store, appId)
    entry.moduleLabel = label?.trim() ? label.trim() : null
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle('apps:extractThemeColor', async (_e, appId: string) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    const wallpaper = entry ? currentWallpaper(entry) : null
    if (!entry || !wallpaper || isVideoFile(wallpaper.file)) return null
    const color = extractAccent(join(BgStore.bgDir(), wallpaper.file))
    if (!color) return null
    entry.themeColor = color
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle(
    'apps:setLaunchMethods',
    async (_e, appId: string, methods: LaunchMethod[], defaultId: string) => {
      const store = await AppStore.load()
      const entry = requireApp(store, appId)
      const cleaned: LaunchMethod[] = (Array.isArray(methods) ? methods : []).map((m, index) => ({
        id: m.id || randomUUID(),
        name: m.name?.trim() || (index === 0 ? '默认' : `启动方式 ${index + 1}`),
        targetPath: (m.targetPath ?? '').trim(),
        arguments: m.arguments ?? '',
        workingDirectory: m.workingDirectory ?? '',
        runAsAdmin: m.runAsAdmin ?? true
      }))
      if (cleaned.length === 0) throw new Error('请至少保留一种启动方式')
      entry.launchMethods = cleaned
      entry.defaultLaunchMethodId = cleaned.some((m) => m.id === defaultId)
        ? defaultId
        : cleaned[0].id
      entry.updatedAt = new Date().toISOString()
      await AppStore.save()
      notifyAppsChanged()
      return entry
    }
  )
}
