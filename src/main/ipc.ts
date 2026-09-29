import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell } from 'electron'
import { randomUUID } from 'crypto'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { tmpdir } from 'os'
import { basename, dirname, extname, join } from 'path'
import { promises as fs } from 'fs'
import type { AppEntry, GalleryItem, NewAppEntry } from '@shared/types'
import { ADDONS } from './addons/registry'
import { AppStore } from './services/appStore'
import { BgStore } from './services/background'
import { BrandStore } from './services/brand'
import { ensureTray, markQuitting, setCloseToTray } from './services/behavior'
import { applyAutoStart } from './services/autostart'
import {
  applyPayload,
  canWrite,
  closeRunningInstances,
  defaultInstallDir,
  detectInstallation,
  finishUninstall,
  freeSpace,
  hasInstallDirArgument,
  inspectTarget,
  installDirArgument,
  installSize,
  normalizeInstallDir,
  relaunchInstallerElevated,
  removeInstallation,
  runningInstances,
  writeShortcuts,
  writeUninstallEntry
} from './services/install'
import { directorySize } from './services/updateDownload'
import { directoriesOverlap } from '@shared/paths'
import {
  currentDataDir,
  defaultDataDir,
  hasData,
  migrateData,
  switchDataDir,
  writeDataDir
} from './services/dataDir'
import { applyLauncherIcon } from './services/appIcon'
import { IconStore } from './services/icon'
import { extractAccent } from './services/theme'
import { Launcher } from './services/launcher'
import { Runtime } from './services/runtime'
import { PlayTimeStore } from './services/playTimeStore'
import { GachaStore } from './gacha/gachaStore'
import { fetchMiHoYoGacha } from './gacha/mihoyo'
import { fetchArknightsGacha } from './gacha/arknights'
import { loginHypergryphToken, silentHypergryphToken } from './gacha/hypergryphAuth'
import { scanWebCache } from './gacha/urlSource'
import { TokenStore } from './services/tokenStore'
import { getHoYoUpdateInfo } from './update/hoyoplay'
import { getArknightsUpdateInfo } from './update/arknightsUpdate'
import { UpdateManager } from './update/updateManager'
import { AppUpdateChecker } from './services/appUpdate'
import { currentAppVersion } from './services/appVersion'
import { log } from './services/logger'

export const runtime = new Runtime()
export const updates = new UpdateManager()
export const appUpdate = new AppUpdateChecker()

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

const notifyAppsChanged = (): void => broadcast('apps:changed')
const execFileAsync = promisify(execFile)

/** Decode a `data:<mime>;base64,...` URL into a buffer. */
function decodeDataUrl(dataUrl: string): Buffer {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl)
  if (!match) throw new Error('无效的图片数据')
  return match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]), 'utf8')
}

let fontCache: string[] | null = null

function fontCacheFile(): string {
  return join(app.getPath('userData'), 'fonts.json')
}

/** Enumerate installed font families (slow) and persist the result. */
async function enumerateFonts(): Promise<string[]> {
  const script =
    "Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }"
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { maxBuffer: 4 * 1024 * 1024, windowsHide: true }
    )
    const list = [...new Set(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b)
    )
    fontCache = list
    try {
      await fs.writeFile(fontCacheFile(), JSON.stringify(list), 'utf-8')
    } catch {
      /* ignore */
    }
    return list
  } catch {
    return fontCache ?? []
  }
}

/** Font family names. Returns the persisted cache instantly, then refreshes. */
async function listSystemFonts(): Promise<string[]> {
  if (fontCache) return fontCache
  try {
    const parsed = JSON.parse(await fs.readFile(fontCacheFile(), 'utf-8')) as string[]
    if (Array.isArray(parsed) && parsed.length) {
      fontCache = parsed
      void enumerateFonts()
      return parsed
    }
  } catch {
    /* no cache yet */
  }
  return enumerateFonts()
}

/** Warm the font cache in the background (so the settings page opens instantly). */
export function warmUpFonts(): void {
  void listSystemFonts()
}

/** Path to the current desktop wallpaper, if it exists. */
async function getDesktopWallpaper(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "(Get-ItemProperty 'HKCU:\\Control Panel\\Desktop').WallPaper"
      ],
      { windowsHide: true }
    )
    const path = stdout.trim()
    if (!path) return null
    await fs.access(path)
    return path
  } catch {
    return null
  }
}

/** Read an image, or extract an executable/shortcut's icon, as a data URL. */
const ICON_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico'])
async function iconDataFromPath(path: string): Promise<string | null> {
  const ext = extname(path).toLowerCase()
  if (ICON_IMAGE_EXTS.has(ext)) {
    try {
      const buffer = await fs.readFile(path)
      const mime =
        ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.gif'
              ? 'image/gif'
              : ext === '.bmp'
                ? 'image/bmp'
                : ext === '.ico'
                  ? 'image/x-icon'
                  : 'image/png'
      return `data:${mime};base64,${buffer.toString('base64')}`
    } catch {
      return null
    }
  }
  try {
    const image = await app.getFileIcon(path, { size: 'large' })
    if (!image.isEmpty()) return `data:image/png;base64,${image.toPNG().toString('base64')}`
  } catch {
    /* ignore */
  }
  return null
}

/** Best-effort recursive directory copy (missing source is ignored). */
async function copyDir(from: string, to: string): Promise<void> {
  const entries = await fs.readdir(from, { withFileTypes: true })
  await fs.mkdir(to, { recursive: true })
  for (const entry of entries) {
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) await copyDir(src, dst)
    else await fs.copyFile(src, dst)
  }
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Entries that are never part of a backup (transient / regenerated data). */
const BACKUP_EXCLUDE = new Set(['logs', 'update-staging'])
const isBackupExcluded = (name: string): boolean =>
  BACKUP_EXCLUDE.has(name) || name.endsWith('.log') || name.startsWith('simulate.')

/**
 * Copies the whole data directory into `stage`, except transient entries. The
 * backup therefore covers every setting automatically — including ones added in
 * future versions — instead of a hard-coded list of files.
 */
async function stageBackup(userData: string, stage: string): Promise<void> {
  const entries = await fs.readdir(userData, { withFileTypes: true })
  for (const entry of entries) {
    if (isBackupExcluded(entry.name)) continue
    const source = join(userData, entry.name)
    const target = join(stage, entry.name)
    if (entry.isDirectory()) await copyDir(source, target)
    else if (entry.isFile()) await fs.copyFile(source, target)
  }
}

/** Restores a staged backup over the data directory (transient entries skipped). */
async function restoreBackup(stage: string, userData: string): Promise<string[]> {
  const restored: string[] = []
  const entries = await fs.readdir(stage, { withFileTypes: true })
  for (const entry of entries) {
    if (isBackupExcluded(entry.name)) continue
    const source = join(stage, entry.name)
    const target = join(userData, entry.name)
    if (entry.isDirectory()) await copyDir(source, target)
    else if (entry.isFile()) await fs.copyFile(source, target)
    restored.push(entry.name)
  }
  return restored
}


const previewApps = new Map<
  string,
  { hasUpdate: boolean; preDownloadVersion: string | null; stopAt?: number }
>()

/**
 * Advertise a fake update/pre-download for an app so the download UI can be
 * previewed; the user still has to click, and the download is then simulated.
 */
export function registerUpdatePreview(
  appId: string,
  mode: 'update' | 'preDownload' | 'both',
  stopAt?: number
): void {
  previewApps.set(appId, {
    hasUpdate: mode === 'update' || mode === 'both',
    preDownloadVersion: mode === 'preDownload' || mode === 'both' ? '9.9.9' : null,
    stopAt
  })
}

export function registerIpc(): void {
  runtime.onChanged(() => broadcast('runtime:changed'))
  updates.onProgress((status) => broadcast('update:progress', status))

  const playTime = PlayTimeStore.instance()
  void playTime.load()
  runtime.onSessionEnded((record) => {
    void playTime.addSession(record).then(() => broadcast('playtime:changed'))
  })

  ipcMain.handle('addons:list', () => ADDONS)

  ipcMain.handle('apps:list', async () => (await AppStore.load()).apps)

  ipcMain.handle('apps:add', async (_e, input: NewAppEntry) => {
    const store = await AppStore.load()
    const now = new Date().toISOString()

    let iconFile: string | null = null
    try {
      const image = await app.getFileIcon(input.targetPath, { size: 'large' })
      if (!image.isEmpty()) iconFile = await IconStore.savePng(image.toPNG())
    } catch {
      /* icon extraction is best-effort */
    }

    const entry: AppEntry = {
      id: randomUUID(),
      name: input.name?.trim() || '未命名应用',
      moduleLabel: input.moduleLabel?.trim() || null,
      targetPath: input.targetPath,
      arguments: input.arguments ?? '',
      workingDirectory: input.workingDirectory ?? '',
      gameDirectory: input.gameDirectory ?? null,
      environmentVariables: input.environmentVariables ?? {},
      runAsAdmin: input.runAsAdmin ?? true,
      addonId: input.addonId ?? null,
      iconFile,
      backgroundFile: null,
      themeColor: null,
      glassStyle: 'dark',
      autoTheme: true,
      backgroundBlur: 0,
      backgroundDim: 25,
      screenshotDirectory: input.screenshotDirectory ?? null,
      monitorProcessNames: input.monitorProcessNames ?? [],
      createdAt: now,
      updatedAt: now
    }
    store.apps.push(entry)

    // Default background: the current desktop wallpaper.
    try {
      const wallpaper = await getDesktopWallpaper()
      if (wallpaper) entry.backgroundFile = await BgStore.import(wallpaper)
    } catch {
      /* ignore */
    }
    if (entry.autoTheme && entry.backgroundFile) {
      const color = extractAccent(join(BgStore.bgDir(), entry.backgroundFile))
      if (color) entry.themeColor = color
    }

    await AppStore.save()
    log(`apps: added "${entry.name}" (${entry.targetPath})`)
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
    if (entry?.backgroundFile) await BgStore.remove(entry.backgroundFile)
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

  ipcMain.handle('image:read', async (_e, path: string) => {
    try {
      const buffer = await fs.readFile(path)
      const ext = extname(path).toLowerCase()
      const mime =
        ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.gif'
              ? 'image/gif'
              : ext === '.bmp'
                ? 'image/bmp'
                : 'image/png'
      return `data:${mime};base64,${buffer.toString('base64')}`
    } catch {
      return null
    }
  })

  ipcMain.handle('fonts:list', () => listSystemFonts())
  ipcMain.handle('app:version', () => currentAppVersion())

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
    await applyLauncherIcon()
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
      }
    ) => {
      await AppStore.setLauncher(patch)
      if (patch.closeAction) setCloseToTray(patch.closeAction === 'tray')
      if (patch.autoStart) applyAutoStart(patch.autoStart)
      broadcast('launcher:changed')
      return AppStore.launcherSettings()
    }
  )

  ipcMain.handle('apps:setBackground', async (_e, appId: string, sourcePath: string | null) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry) throw new Error('应用不存在')
    if (entry.backgroundFile) {
      await BgStore.remove(entry.backgroundFile)
      entry.backgroundFile = null
    }
    if (sourcePath) entry.backgroundFile = await BgStore.import(sourcePath)
    if (entry.autoTheme && entry.backgroundFile) {
      const color = extractAccent(join(BgStore.bgDir(), entry.backgroundFile))
      if (color) entry.themeColor = color
    }
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle('apps:setIcon', async (_e, appId: string, sourcePath: string | null) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry) throw new Error('应用不存在')
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
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry) throw new Error('应用不存在')
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
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry) throw new Error('应用不存在')
    if (entry.iconFile) {
      await IconStore.remove(entry.iconFile)
      entry.iconFile = null
    }
    try {
      const image = await app.getFileIcon(entry.targetPath, { size: 'large' })
      if (!image.isEmpty()) entry.iconFile = await IconStore.savePng(image.toPNG())
    } catch {
      /* ignore */
    }
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle('apps:resetBackground', async (_e, appId: string) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry) throw new Error('应用不存在')
    if (entry.backgroundFile) {
      await BgStore.remove(entry.backgroundFile)
      entry.backgroundFile = null
    }
    const wallpaper = await getDesktopWallpaper()
    if (wallpaper) entry.backgroundFile = await BgStore.import(wallpaper)
    if (entry.autoTheme && entry.backgroundFile) {
      const color = extractAccent(join(BgStore.bgDir(), entry.backgroundFile))
      if (color) entry.themeColor = color
    }
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle('apps:setAutoTheme', async (_e, appId: string, on: boolean) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry) throw new Error('应用不存在')
    entry.autoTheme = on
    if (on && entry.backgroundFile) {
      const color = extractAccent(join(BgStore.bgDir(), entry.backgroundFile))
      if (color) entry.themeColor = color
    }
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle('apps:setThemeColor', async (_e, appId: string, color: string | null) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry) throw new Error('应用不存在')
    entry.themeColor = color
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle('apps:setGlassStyle', async (_e, appId: string, style: 'dark' | 'light') => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry) throw new Error('应用不存在')
    entry.glassStyle = style === 'light' ? 'light' : 'dark'
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle(
    'apps:setBgTuning',
    async (_e, appId: string, tuning: { blur: number; dim: number }) => {
      const store = await AppStore.load()
      const entry = store.apps.find((a) => a.id === appId)
      if (!entry) throw new Error('应用不存在')
      entry.backgroundBlur = Math.max(0, Math.min(60, Math.round(tuning.blur) || 0))
      entry.backgroundDim = Math.max(0, Math.min(100, Math.round(tuning.dim)))
      entry.updatedAt = new Date().toISOString()
      await AppStore.save()
      notifyAppsChanged()
      return entry
    }
  )

  ipcMain.handle('apps:extractThemeColor', async (_e, appId: string) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry?.backgroundFile) return null
    const color = extractAccent(join(BgStore.bgDir(), entry.backgroundFile))
    if (!color) return null
    entry.themeColor = color
    entry.updatedAt = new Date().toISOString()
    await AppStore.save()
    notifyAppsChanged()
    return entry
  })

  ipcMain.handle('apps:launch', async (_e, id: string) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === id)
    if (!entry) throw new Error('应用不存在')
    const result = await Launcher.launch(entry)
    if (result.ok) {
      // Elevated launches (when the launcher itself is not elevated) cannot be
      // tracked by pid; fall back to monitoring the target's own process name.
      const monitor = [...entry.monitorProcessNames]
      if (result.elevated && result.pid === null && monitor.length === 0) {
        monitor.push(basename(entry.targetPath))
      }
      runtime.start(entry.id, result.pid, result.elevated, monitor)
    }
    return result
  })

  ipcMain.handle('runtime:list', () => runtime.list())
  ipcMain.handle('runtime:stop', (_e, appId: string) => runtime.stop(appId))

  ipcMain.handle('playtime:totals', async () => {
    await playTime.load()
    return playTime.totalsMap()
  })
  ipcMain.handle('playtime:summary', async (_e, appId: string, days?: number) => {
    await playTime.load()
    return playTime.summary(appId, days)
  })

  const gacha = new GachaStore()

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
    const added = await gacha.importRecords(appId, raw)
    return added
  })

  // ---- full backup / restore (config + playtime + gacha + icons/bg) ----

  const userData = app.getPath('userData')

  ipcMain.handle('data:export', async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const picked = await dialog.showSaveDialog({
      title: '导出设置',
      defaultPath: `KevinLauncher-设置备份-${stamp}.zip`,
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
    })
    if (picked.canceled || !picked.filePath) return null

    const stage = await fs.mkdtemp(join(tmpdir(), 'kl-export-'))
    try {
      await stageBackup(userData, stage)
      await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Compress-Archive -Path ${psQuote(join(stage, '*'))} -DestinationPath ${psQuote(picked.filePath)} -Force`
        ],
        { windowsHide: true }
      )
      log(`data: exported to ${picked.filePath}`)
      return picked.filePath
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  ipcMain.handle('data:import', async () => {
    const picked = await dialog.showOpenDialog({
      title: '导入设置',
      properties: ['openFile'],
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return null

    const work = await fs.mkdtemp(join(tmpdir(), 'kl-import-'))
    try {
      const zip = join(work, 'data.zip')
      await fs.copyFile(picked.filePaths[0], zip)
      const out = join(work, 'out')
      await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -Path ${psQuote(zip)} -DestinationPath ${psQuote(out)} -Force`
        ],
        { windowsHide: true }
      )
      await restoreBackup(out, userData)
      await AppStore.reload()
      await playTime.reload()
      gacha.reload()
      await applyLauncherIcon()
      broadcast('apps:changed')
      broadcast('playtime:changed')
      broadcast('launcher:changed')
      const config = await AppStore.load()
      log(`data: imported (${config.apps.length} apps)`)
      return { apps: config.apps.length }
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  })

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
    const gameDir = entry.gameDirectory?.trim() || dirname(entry.targetPath)
    const info =
      entry.addonId === 'arknights'
        ? await getArknightsUpdateInfo(gameDir)
        : await getHoYoUpdateInfo(entry.addonId, gameDir)
    const preview = previewApps.get(appId)
    if (preview) {
      info.supported = true
      if (preview.hasUpdate) {
        info.hasUpdate = true
        info.latestVersion = info.latestVersion ?? '9.9.9'
      }
      if (preview.preDownloadVersion) info.preDownloadVersion = preview.preDownloadVersion
    }
    return info
  })

  ipcMain.handle('update:start', async (_e, appId: string, mode: 'update' | 'preDownload') => {
    // Preview mode: fake the download instead of hitting the real servers.
    const preview = previewApps.get(appId)
    if (preview) {
      updates.simulate(appId, mode, mode === 'preDownload' ? preview.stopAt : undefined)
      return
    }
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    if (!entry?.addonId) throw new Error('该应用未绑定游戏模块')
    const gameDir = entry.gameDirectory?.trim() || dirname(entry.targetPath)
    await updates.start(appId, mode, entry.addonId, gameDir)
  })

  ipcMain.handle('update:cancel', (_e, appId: string) => updates.cancel(appId))
  ipcMain.handle('update:status', (_e, appId: string) => updates.status(appId))
  ipcMain.handle('update:simulate', (_e, appId: string, mode: 'update' | 'preDownload') =>
    updates.simulate(appId, mode)
  )

  ipcMain.handle('gallery:list', async (_e, appId: string) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    const dir = entry?.screenshotDirectory
    if (!dir) return []
    const items: GalleryItem[] = []
    await collectImages(dir, items)
    items.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return items
  })

  ipcMain.handle('gallery:openViewer', (_e, path: string) => {
    const viewer = new BrowserWindow({
      width: 1040,
      height: 740,
      minWidth: 480,
      minHeight: 360,
      frame: false,
      backgroundColor: '#0b0d12',
      autoHideMenuBar: true,
      title: '查看图片',
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
    })
    viewer.setMenuBarVisibility(false)
    const hash = `viewer=${encodeURIComponent(path)}`
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) viewer.loadURL(`${devUrl}#${hash}`)
    else viewer.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  })

  ipcMain.handle('gallery:contextMenu', (e, path: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    const menu = Menu.buildFromTemplate([
      { label: '在文件资源管理器中打开', click: () => shell.showItemInFolder(path) },
      {
        label: '复制图片',
        click: () => {
          const image = nativeImage.createFromPath(path)
          if (!image.isEmpty()) clipboard.writeImage(image)
        }
      }
    ])
    menu.popup({ window: win })
  })

  ipcMain.handle('dialog:pickExecutable', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: '可执行文件 / 脚本', extensions: ['exe', 'bat', 'cmd', 'ps1', 'lnk'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:pickBackground', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: '图片 / 视频', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp4', 'webm'] }
      ]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:pickImage', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Icon source: an image, or an exe/bat/cmd/ps1/lnk whose icon we extract.
  ipcMain.handle('dialog:pickIconSource', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        {
          name: '图片 / 可执行文件 / 快捷方式',
          extensions: [
            'png',
            'jpg',
            'jpeg',
            'webp',
            'gif',
            'bmp',
            'ico',
            'exe',
            'bat',
            'cmd',
            'ps1',
            'lnk'
          ]
        },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    const dataUrl = await iconDataFromPath(path)
    return dataUrl ? { path, dataUrl } : null
  })

  ipcMain.handle('image:iconFromPath', (_e, path: string) => iconDataFromPath(path))

  ipcMain.handle('dialog:pickDirectory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('shell:openPath', async (_e, path: string) => {
    await shell.openPath(path)
  })

  // Only http(s) links may be opened externally (never file:// or custom schemes).
  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  // --- launcher self-update (GitHub Releases) -------------------------------
  appUpdate.onUpdate((info) => broadcast('app-update:available', info))
  appUpdate.onState((state) => broadcast('app-update:state', state))
  ipcMain.handle('appUpdate:status', () => appUpdate.status())
  ipcMain.handle('appUpdate:check', () => appUpdate.check())
  ipcMain.handle('appUpdate:state', () => appUpdate.stateSnapshot())
  ipcMain.handle('appUpdate:start', () => appUpdate.begin())
  ipcMain.handle('appUpdate:toggle', () => appUpdate.toggle())

  // --- installer / uninstaller UI (fresh install + --uninstall) -------------
  ipcMain.handle('installer:info', async () => {
    const detected = await detectInstallation()
    const running = await runningInstances()
    const explicit = installDirArgument()
    return {
      defaultDir: defaultInstallDir(),
      detected: detected ?? (running.length ? { dir: dirname(running[0]), version: null, source: 'running' as const } : null),
      target: detected ? await inspectTarget(detected.dir) : null,
      running,
      prefillDir: explicit ?? (detected ? normalizeInstallDir(detected.dir) : defaultInstallDir()),
      payloadSize: await installSize(),
      version: currentAppVersion(),
      dataDir: app.getPath('userData')
    }
  })
  ipcMain.handle('installer:normalize', (_e, dir: string) => normalizeInstallDir(dir))
  ipcMain.handle('installer:running', () => runningInstances())
  ipcMain.handle('installer:inspect', (_e, dir: string) => inspectTarget(dir))
  ipcMain.handle('installer:freeSpace', (_e, dir: string) => freeSpace(dir))
  ipcMain.handle('installer:pickDirectory', async (e, current: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择安装位置',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current || defaultInstallDir()
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('installer:run', async (e, requested: string, requestedDataDir?: string) => {
    const sender = e.sender
    const dir = normalizeInstallDir(requested)
    const source = dirname(process.execPath)

    // The data directory must never be the program directory (or inside it):
    // an upgrade/uninstall would otherwise delete the user's data.
    if (requestedDataDir && directoriesOverlap(dir, requestedDataDir)) {
      throw new Error('用户数据目录不能与安装目录相同，也不能互相包含')
    }

    // A new directory that needs administrator rights: ask for UAC and continue
    // in the elevated instance with the same target.
    if (!(await canWrite(dir)) && !hasInstallDirArgument()) {
      relaunchInstallerElevated()
      markQuitting()
      app.quit()
      return false
    }

    // Files of a running launcher are locked — close it first.
    const remaining = await closeRunningInstances()
    if (remaining > 0) {
      throw new Error('检测到仍在运行的 KevinLauncher，请先退出后重试')
    }

    await applyPayload(source, dir, (progress) => {
      if (!sender.isDestroyed()) sender.send('installer:progress', { phase: 'copying', ...progress })
    })
    if (!sender.isDestroyed()) {
      sender.send('installer:progress', { phase: 'shortcuts', done: 0, total: 0, current: '' })
    }
    writeShortcuts(dir)
    await writeUninstallEntry(dir, currentAppVersion())

    // Remember the chosen data directory (and take existing data along).
    if (requestedDataDir) {
      const target = requestedDataDir.trim()
      const fallback = defaultDataDir()
      if (target && target.toLowerCase() !== fallback.toLowerCase()) {
        if (await hasData(fallback)) await migrateData(fallback, target)
        await writeDataDir(target)
        log(`install: data directory set to ${target}`)
      } else {
        await writeDataDir(fallback)
      }
    }

    // Autostart defaults to ON after a fresh install (scheduled task, silent UAC).
    await AppStore.setLauncher({ autoStart: 'window' })
    await applyAutoStart('window')
    log(`install: finished (${dir})`)
    return true
  })

  // --- data directory (moved by the user in the settings) -------------------
  ipcMain.handle('dataDir:get', () => ({
    current: currentDataDir(),
    default: defaultDataDir(),
    programDir: dirname(process.execPath)
  }))
  ipcMain.handle('dataDir:pick', async (e, current: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择数据目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current || defaultDataDir()
    })
    return result.canceled ? null : normalizeInstallDir(result.filePaths[0] ?? '')
  })
  /** Moves the data to `dir` and restarts the launcher. */
  ipcMain.handle('dataDir:set', (e, dir: string) => {
    const target = normalizeInstallDir(dir)
    if (directoriesOverlap(target, dirname(process.execPath))) {
      throw new Error('数据目录不能与程序目录相同，也不能互相包含')
    }
    const sender = e.sender
    return switchDataDir(target, (step) => {
      if (!sender.isDestroyed()) sender.send('dataDir:progress', { step })
    })
  })
  ipcMain.handle('installer:launch', async (_e, dir: string) => {
    // Start it as a *launcher*, not as an installer: the portable variables are
    // inherited through the environment and would put the new process back into
    // install mode (showing another installer window instead of the app).
    const env = { ...process.env }
    delete env.PORTABLE_EXECUTABLE_FILE
    delete env.PORTABLE_EXECUTABLE_DIR
    spawn(join(dir, 'KevinLauncher.exe'), [], {
      detached: true,
      stdio: 'ignore',
      cwd: dir,
      env
    }).unref()
    markQuitting()
    app.quit()
  })

  ipcMain.handle('uninstaller:info', async () => {
    const dir = dirname(process.execPath)
    const detected = await detectInstallation()
    return {
      installDir: detected?.dir ?? dir,
      version: currentAppVersion(),
      dataDir: app.getPath('userData'),
      dataSize: await directorySize(app.getPath('userData')),
      installSize: await directorySize(dir)
    }
  })
  ipcMain.handle('uninstaller:run', async (e, keepUserData: boolean) => {
    const sender = e.sender
    const dir = dirname(process.execPath)
    const detected = await detectInstallation()
    await removeInstallation({
      installDir: detected?.dir ?? dir,
      keepUserData,
      onProgress: (step) => {
        if (!sender.isDestroyed()) sender.send('uninstaller:progress', { step })
      }
    })
    finishUninstall(detected?.dir ?? dir)
    markQuitting()
    app.quit()
  })

  ipcMain.handle('window:minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })
  ipcMain.handle('window:toggleMaximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('window:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })
  ipcMain.handle('window:hideToTray', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    win.hide()
    void ensureTray()
  })
  ipcMain.handle('window:isMaximized', (e) => {
    return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false
  })
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'])

async function collectImages(dir: string, out: GalleryItem[], depth = 0): Promise<void> {
  if (depth > 6 || out.length >= 3000) return
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= 3000) return
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectImages(full, out, depth + 1)
    } else if (IMAGE_EXT.has(extname(entry.name).toLowerCase())) {
      try {
        const stat = await fs.stat(full)
        out.push({ path: full, name: entry.name, mtimeMs: stat.mtimeMs, size: stat.size })
      } catch {
        /* skip unreadable file */
      }
    }
  }
}
