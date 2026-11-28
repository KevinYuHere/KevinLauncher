import { app, dialog, nativeImage } from 'electron'
import { handleIpc } from './access'
import { randomUUID } from 'crypto'
import { copyFile } from 'fs/promises'
import { basename, join } from 'path'
import {
  DEFAULT_GLASS_APPEARANCE,
  DEFAULT_HOME_MODULE,
  DEFAULT_WALLPAPER_SETTINGS,
  HOME_MODULES,
  LAUNCHER_BEHAVIOR_FIELDS,
  type AppEntry,
  type AppSettingsPatch,
  type GlassPatch,
  type HomeModuleId,
  type HomeModuleState,
  type LaunchEffect,
  type LauncherBehaviorPatch,
  type LauncherFontPatch,
  type LaunchMethod,
  type NewAppEntry
} from '@shared/types'
import { currentWallpaper, defaultLaunchMethod, isVideoFile } from '@shared/appEntry'
import { normalizeLauncherFontFamily } from '@shared/launcherFonts'
import { ADDONS } from '../addons/registry'
import { AppStore } from '../services/appStore'
import { applyAutoTheme } from '../services/accent'
import { BgStore } from '../services/background'
import { BrandStore } from '../services/brand'
import { mergeGlass } from '../services/glass'
import { IconStore } from '../services/icon'
import { applyAutoStart } from '../services/autostart'
import { applyLauncherIcon } from '../services/appIcon'
import { setCloseToTray } from '../services/behavior'
import { resolveScreenshotDirectoryChange } from '../services/mediaAccess'
import { extractAccent } from '../services/theme'
import { log } from '../services/logger'
import { broadcast, notifyAppsChanged } from './context'
import { decodeDataUrl, errorText, getDesktopWallpaper } from './util'


async function changeApp(appId: string, change: (entry: AppEntry) => void | Promise<void>): Promise<AppEntry> {
  const entry = await AppStore.mutateApp(appId, change)
  notifyAppsChanged()
  return entry
}

function readIconData(dataUrl: string): Buffer {
  const image = nativeImage.createFromBuffer(decodeDataUrl(dataUrl))
  if (image.isEmpty()) throw new Error('无法读取这个图标，请换一张图片重试')
  return image.toPNG()
}

export function registerAppsIpc(): void {
  // Export the launcher logs to a user-chosen directory (for support).
  handleIpc('logs:export', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择日志导出位置',
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

  handleIpc('addons:list', () => ADDONS)

  handleIpc('apps:list', async () => (await AppStore.load()).apps)

  handleIpc('apps:add', async (_e, input: NewAppEntry) => {
    const now = new Date().toISOString()
    const screenshotDirectory = await resolveScreenshotDirectoryChange(null, input.screenshotDirectory ?? null)

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

    const entry: AppEntry = {
      id: randomUUID(),
      name: input.name?.trim() || '未命名应用',
      moduleLabel: input.moduleLabel?.trim() || null,
      launchMethods: methods,
      defaultLaunchMethodId: methods[0].id,
      gameDirectory: input.gameDirectory ?? null,
      environmentVariables: input.environmentVariables ?? {},
      addonId: input.addonId ?? null,
      iconFile: null,
      wallpapers: [],
      wallpaperSettings: { ...DEFAULT_WALLPAPER_SETTINGS },
      wallpaperIndex: 0,
      themeColor: null,
      glass: { ...DEFAULT_GLASS_APPEARANCE },
      autoTheme: true,
      backgroundBlur: 0,
      backgroundDim: 25,
      screenshotDirectory,
      monitorProcessNames: input.monitorProcessNames ?? [],
      gachaShowSecond: true,
      linkedLaunchIds: [],
      defaultLinkedLaunchId: null,
      launchEffect: input.launchEffect ?? 'none',
      createdAt: now,
      updatedAt: now
    }
    const created = await AppStore.mutate(async (store) => {
      store.apps.push(entry)
      if (methods[0].targetPath) {
        try {
          const image = await app.getFileIcon(methods[0].targetPath, { size: 'large' })
          if (!image.isEmpty()) entry.iconFile = await IconStore.savePng(image.toPNG())
        } catch {
          /* icon extraction is best-effort */
        }
      }
      try {
        const wallpaper = await getDesktopWallpaper()
        if (wallpaper) {
          entry.wallpapers.push({
            id: randomUUID(), file: await BgStore.import(wallpaper), name: basename(wallpaper)
          })
        }
      } catch {
        /* desktop wallpaper is optional */
      }
      await applyAutoTheme(entry)
      return entry
    })
    log(`apps: added "${entry.name}" (${methods[0].targetPath})`)
    notifyAppsChanged()
    return created
  })

  handleIpc('apps:update', async (_e, id: string, patch: AppSettingsPatch) => {
    // Validate against the stored entry inside the store queue so a concurrent
    // update cannot make the authorization decision use a stale directory.
    const updated = await AppStore.patchApp(id, patch, async (entry) => {
      if (!Object.hasOwn(patch, 'screenshotDirectory')) return
      patch.screenshotDirectory = await resolveScreenshotDirectoryChange(
        entry.screenshotDirectory,
        patch.screenshotDirectory
      )
    })
    notifyAppsChanged()
    return updated
  })

  handleIpc('apps:remove', async (_e, id: string) => {
    await AppStore.mutate((store) => { store.apps = store.apps.filter((entry) => entry.id !== id) })
    notifyAppsChanged()
  })

  handleIpc('apps:reorder', async (_e, ids: string[]) => {
    const apps = await AppStore.reorder(ids)
    notifyAppsChanged()
    return apps
  })

  handleIpc('ui:getPrefs', () => AppStore.uiPrefs())

  handleIpc('ui:setGamesRowHidden', async (_e, hidden: boolean) => {
    await AppStore.setGamesRowHidden(hidden)
    return AppStore.uiPrefs()
  })

  // ---------------------------------------------------------------- launcher
  handleIpc('launcher:getSettings', () => AppStore.launcherSettings())

  handleIpc('launcher:setIcon', async (_e, dataUrl: string | null) => {
    const png = dataUrl ? readIconData(dataUrl) : null
    let iconFile: string | null = null
    let committed = false
    try {
      await AppStore.mutate(async (store) => {
        store.launcher = { ...store.launcher, iconFile: null }
        if (png) {
          iconFile = await BrandStore.savePng(png)
          store.launcher.iconFile = iconFile
          await BrandStore.saveIcoFor(iconFile, png)
        }
      }, async () => {
        committed = true
        await applyLauncherIcon({ iconFile, refreshShell: true, reportFailure: true })
      })
    } catch (error) {
      if (!committed) throw error
      broadcast('launcher:changed')
      throw new Error(`图标已保存，但更新快捷方式失败：${errorText(error)}`)
    }
    // User-initiated: refresh the shell caches immediately (including the Start
    // Menu host, which otherwise keeps showing the old icon until logon).
    broadcast('launcher:changed')
    return AppStore.launcherSettings()
  })

  handleIpc('launcher:setFont', async (_e, family: string | null) => {
    const normalized = normalizeLauncherFontFamily(family)
    await AppStore.setLauncher({
      fontFamily: normalized,
      fontFamilyEn: normalized,
      fontFamilyZh: normalized
    })
    broadcast('launcher:changed')
    return AppStore.launcherSettings()
  })

  handleIpc('launcher:setFonts', async (_e, patch: LauncherFontPatch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.keys(patch).length === 0 ||
        Object.keys(patch).some((key) => key !== 'en' && key !== 'zh')) {
      throw new Error('字体设置无效，请重新选择字体')
    }
    const next: { fontFamilyEn?: string | null; fontFamilyZh?: string | null } = {}
    if (Object.hasOwn(patch, 'en')) next.fontFamilyEn = normalizeLauncherFontFamily(patch.en)
    if (Object.hasOwn(patch, 'zh')) next.fontFamilyZh = normalizeLauncherFontFamily(patch.zh)
    await AppStore.setLauncher(next)
    broadcast('launcher:changed')
    return AppStore.launcherSettings()
  })

  handleIpc(
    'launcher:setBehavior',
    async (_e, patch: LauncherBehaviorPatch) => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
          Object.keys(patch).some((key) => !(LAUNCHER_BEHAVIOR_FIELDS as readonly string[]).includes(key))) {
        throw new Error('启动器设置无效，请刷新后重试')
      }
      await AppStore.setLauncher(patch)
      if (patch.closeAction) setCloseToTray(patch.closeAction === 'tray')
      try {
        if (patch.autoStart) await applyAutoStart(patch.autoStart)
      } catch (error) {
        throw new Error(`设置已保存，但开机自启未能生效：${errorText(error)}`)
      } finally {
        broadcast('launcher:changed')
      }
      return AppStore.launcherSettings()
    }
  )

  // -------------------------------------------------------------- appearance
  handleIpc('apps:setIcon', (_e, appId: string, sourcePath: string | null) =>
    changeApp(appId, async (entry) => {
      entry.iconFile = sourcePath ? await IconStore.import(sourcePath) : null
    })
  )

  handleIpc('apps:setIconData', (_e, appId: string, dataUrl: string | null) =>
    changeApp(appId, async (entry) => {
      entry.iconFile = dataUrl ? await IconStore.savePng(readIconData(dataUrl)) : null
    })
  )

  handleIpc('apps:resetIcon', (_e, appId: string) =>
    changeApp(appId, async (entry) => {
      const target = defaultLaunchMethod(entry)?.targetPath
      if (!target) {
        entry.iconFile = null
        return
      }
      const image = await app.getFileIcon(target, { size: 'large' })
      entry.iconFile = image.isEmpty() ? null : await IconStore.savePng(image.toPNG())
    })
  )

  handleIpc('apps:setAutoTheme', (_e, appId: string, on: boolean) =>
    changeApp(appId, async (entry) => {
      entry.autoTheme = on
      await applyAutoTheme(entry)
    })
  )

  handleIpc('apps:setThemeColor', (_e, appId: string, color: string | null) =>
    changeApp(appId, (entry) => { entry.themeColor = color })
  )

  handleIpc('apps:setGlass', (_e, appId: string, patch: GlassPatch) =>
    changeApp(appId, (entry) => { entry.glass = mergeGlass(entry.glass, patch) })
  )

  handleIpc('apps:setBgTuning', (_e, appId: string, tuning: { blur: number; dim: number }) =>
    changeApp(appId, (entry) => {
      entry.backgroundBlur = Math.max(0, Math.min(60, Math.round(tuning.blur) || 0))
      entry.backgroundDim = Math.max(0, Math.min(100, Math.round(tuning.dim)))
    })
  )

  handleIpc('apps:setGachaShowSecond', (_e, appId: string, value: boolean) =>
    changeApp(appId, (entry) => { entry.gachaShowSecond = value })
  )

  handleIpc('apps:setHomeModule', (_e, appId: string, moduleId: HomeModuleId, patch: Partial<HomeModuleState>) =>
    changeApp(appId, (entry) => {
      const def = HOME_MODULES.find((module) => module.id === moduleId)
      if (!def) throw new Error('找不到这个主页模块，请刷新后重试')
      const next: HomeModuleState = { ...DEFAULT_HOME_MODULE, ...entry.homeModules?.[moduleId] }
      if (patch.visible != null) next.visible = def.hideable ? patch.visible : true
      if (patch.draggable != null) next.draggable = patch.draggable
      if (patch.x !== undefined) next.x = patch.x == null ? null : Math.max(0, Math.min(1, patch.x))
      if (patch.y !== undefined) next.y = patch.y == null ? null : Math.max(0, Math.min(1, patch.y))
      entry.homeModules = { ...entry.homeModules, [moduleId]: next }
    })
  )

  handleIpc('apps:setLaunchEffect', (_e, appId: string, effect: LaunchEffect) =>
    changeApp(appId, (entry) => { entry.launchEffect = effect })
  )

  handleIpc('apps:setModuleLabel', (_e, appId: string, label: string | null) =>
    changeApp(appId, (entry) => { entry.moduleLabel = label?.trim() || null })
  )

  handleIpc('apps:extractThemeColor', async (_e, appId: string) => {
    const result = await AppStore.mutate(async (store) => {
      const entry = store.apps.find((item) => item.id === appId)
      const wallpaper = entry ? currentWallpaper(entry) : null
      if (!entry || !wallpaper || isVideoFile(wallpaper.file)) return null
      const color = await extractAccent(join(BgStore.bgDir(), wallpaper.file))
      if (!color) return null
      entry.themeColor = color
      entry.updatedAt = new Date().toISOString()
      return entry
    })
    if (result) notifyAppsChanged()
    return result
  })

  handleIpc('apps:setLaunchMethods', (_e, appId: string, methods: LaunchMethod[], defaultId: string) =>
    changeApp(appId, (entry) => {
      if (!Array.isArray(methods) || methods.length === 0) throw new Error('请至少保留一种启动方式')
      if (new Set(methods.map(({ id }) => id)).size !== methods.length) throw new Error('启动方式有重复项，请修改后再保存')
      const existing = new Set(entry.launchMethods.map(({ id }) => id))
      const defaultIndex = Math.max(0, methods.findIndex((method) => method.id === defaultId))
      entry.launchMethods = methods.map((method, index) => ({
        id: existing.has(method.id) || /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(method.id)
          ? method.id : randomUUID(),
        name: method.name?.trim() || (index === 0 ? '默认' : `启动方式 ${index + 1}`),
        targetPath: (method.targetPath ?? '').trim(),
        arguments: method.arguments ?? '',
        workingDirectory: method.workingDirectory ?? '',
        runAsAdmin: method.runAsAdmin ?? true
      }))
      entry.defaultLaunchMethodId = entry.launchMethods[defaultIndex].id
    })
  )
}
