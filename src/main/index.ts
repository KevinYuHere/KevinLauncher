import { app, shell, BrowserWindow, protocol, net } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import { join, basename } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc, registerUpdatePreview, runtime, warmUpFonts, appUpdate } from './ipc'
import { AppStore } from './services/appStore'
import { applyLauncherIcon, launcherIconPaths } from './services/appIcon'
import {
  destroyTray,
  ensureTray,
  getCloseToTray,
  isQuitting,
  markQuitting,
  setCloseToTray,
  showMainWindow
} from './services/behavior'
import { applyAutoStart, startedHidden } from './services/autostart'
import { applyDataDir } from './services/dataDir'
import { relaunchInstallerElevated } from './services/install'

const execFileAsync = promisify(execFile)
import { BgStore } from './services/background'
import { BrandStore } from './services/brand'
import { IconStore } from './services/icon'
import { isElevated } from './services/elevation'
import { log } from './services/logger'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kevin-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  }
])

// Keep the same userData directory (`%APPDATA%\kevin-launcher`) for both dev
// and packaged builds so config / icons / backgrounds stay shared. A custom
// directory (chosen in the installer or in the settings) is stored in the
// registry and applied here, before anything reads `app.getPath('userData')`.
app.setName('kevin-launcher')
applyDataDir()

/** Window size / role of the current run. */
type RunMode = 'app' | 'install' | 'uninstall'

/**
 * `--uninstall` is what the Windows Settings entry runs; the portable
 * `KevinLauncher-Installer-*.exe` sets `PORTABLE_EXECUTABLE_FILE`, in which case
 * the payload always acts as the installer (never as a portable app).
 */
function detectMode(): RunMode {
  if (process.argv.includes('--uninstall')) return 'uninstall'
  if (process.env.PORTABLE_EXECUTABLE_FILE || process.argv.includes('--install')) return 'install'
  return 'app'
}

const runMode: RunMode = detectMode()

/** Set once the launcher holds the single-instance lock (app mode only). */
let holdsLock = false

/** Icon used for the window / taskbar (resolved once on startup). */
let windowIcon: string | undefined

/**
 * Relaunch the current executable elevated (used by packaged builds).
 *
 * Resolves `true` once the elevated process was created. PowerShell is awaited
 * on purpose: quitting immediately after spawning used to lose the race, so
 * double-clicking the shortcut appeared to do nothing.
 */
async function relaunchElevated(): Promise<boolean> {
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
  const args = process.argv.slice(1).map(quote)
  // `-ArgumentList @()` is rejected by Start-Process, so only pass it when there
  // actually are arguments (this used to make every elevation attempt fail).
  const script =
    `Start-Process -FilePath ${quote(process.execPath)}` +
    (args.length ? ` -ArgumentList @(${args.join(',')})` : '') +
    ' -Verb RunAs'
  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 180_000 }
    )
    return true
  } catch (error) {
    log(`app: elevation failed (${(error as Error).message})`)
    return false
  }
}

/** Window size / role of the current run. */
function createWindow(icon?: string, hidden = false, mode: RunMode = 'app'): void {
  const setup = mode !== 'app'
  const mainWindow = new BrowserWindow({
    width: setup ? 1000 : 1180,
    height: setup ? 680 : 760,
    minWidth: setup ? 940 : 900,
    minHeight: setup ? 620 : 600,
    resizable: setup ? false : true,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    title: 'KevinLauncher',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    // Autostart in tray mode: stay hidden, the tray icon opens the window.
    if (hidden) return
    mainWindow.show()
    mainWindow.focus()
    // Nudge to the foreground (Windows can otherwise keep another window in front).
    mainWindow.setAlwaysOnTop(true)
    setTimeout(() => {
      if (!mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false)
    }, 150)
  })
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized', true))
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized', false))

  mainWindow.on('close', (event) => {
    if (getCloseToTray() && !isQuitting()) {
      event.preventDefault()
      mainWindow.hide()
      void ensureTray()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: mode })
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.kevin.kevinlauncher')

  // Elevation must happen *before* the single-instance lock: a non-elevated
  // instance that took the lock and then relaunched itself elevated would lose
  // the race (the elevated process finds the lock taken and exits), so
  // double-clicking the shortcut would appear to do nothing.
  //
  // Packaged launcher runs elevated so launching protected game clients never
  // triggers a UAC prompt and their processes can be tracked/stopped. In dev
  // this is handled by scripts/dev.ps1 (avoids an electron-vite restart loop).
  // The installer elevates itself only when the chosen directory needs it and
  // the uninstaller never needs administrator rights.
  if (runMode === 'app' && !is.dev && !(await isElevated())) {
    log('app: not elevated — requesting administrator rights')
    if (await relaunchElevated()) {
      app.quit()
      return
    }
    // UAC was declined or unavailable: keep running without administrator
    // rights (games then ask for elevation when they are launched) rather than
    // leaving the user with no window at all.
    log('app: continuing without administrator rights')
  }

  // The installer always runs elevated: it may have to stop a launcher that runs
  // elevated itself and to write into protected directories. Elevating up front
  // (before any UI) means the setup never has to quit itself half way through —
  // which looked like "the installer closed itself".
  if (runMode === 'install' && !is.dev && !(await isElevated())) {
    log('install: requesting administrator rights')
    if (await relaunchInstallerElevated()) {
      app.quit()
      return
    }
    // UAC declined: keep going non-elevated rather than closing the setup, so
    // the user is never left with a window that simply vanished.
    log('install: continuing without administrator rights')
  }

  // Only a single instance of the *launcher* may run. The installer/uninstaller
  // deliberately skip the lock: opening the installer while the launcher runs
  // must open the installer (it closes the launcher before overwriting it).
  if (runMode === 'app') {
    if (!app.requestSingleInstanceLock()) {
      log('app: another instance holds the lock — exiting')
      app.quit()
      return
    }
    holdsLock = true
    app.on('second-instance', () => showMainWindow())
  }
  log(`app: mode=${runMode} packaged=${app.isPackaged} dev=${is.dev}`)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Serves images from the launcher's `bg` / `icons` directories, and any
  // absolute file path (for the gallery): kevin-media://file/<base64url>.
  protocol.handle('kevin-media', (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'file') {
      const encoded = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const filePath = Buffer.from(encoded, 'base64url').toString('utf8')
      return net.fetch(pathToFileURL(filePath).toString())
    }
    if (url.hostname === 'default') {
      // Bundled assets (default launcher icon) next to the app resources.
      const name = basename(decodeURIComponent(url.pathname))
      const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
      return net.fetch(pathToFileURL(join(root, name)).toString())
    }
    const name = basename(decodeURIComponent(url.pathname))
    const dir =
      url.hostname === 'icon'
        ? IconStore.dir()
        : url.hostname === 'brand'
          ? BrandStore.dir()
          : BgStore.bgDir()
    return net.fetch(pathToFileURL(join(dir, name)).toString())
  })

  void isElevated().then((elevated) => log(`app: administrator=${elevated}`))

  registerIpc()

  const mode = runMode
  windowIcon = (await launcherIconPaths()).png
  // `startedHidden()` is true when the Run entry launched us with `--tray`.
  createWindow(windowIcon, mode === 'app' && startedHidden(), mode)

  // In install / uninstall mode the app is just a small setup UI: no tray, no
  // autostart, no update checking.
  if (mode !== 'app') return

  const launcherSettings = await AppStore.launcherSettings()
  setCloseToTray(launcherSettings.closeAction === 'tray')
  applyAutoStart(launcherSettings.autoStart)

  // Icons first (window + tray image), then the tray itself: creating the tray
  // before the icon is resolved would leave it with a generic image.
  await applyLauncherIcon()
  await ensureTray()
  warmUpFonts()

  // Check GitHub Releases shortly after launch, then every 24 hours.
  appUpdate.start()
  // Remove `app-<old version>` directories left over from previous updates.
  void appUpdate.cleanupOldVersions()

  // One-shot download-UI preview: if `%userData%/simulate.json` exists, advertise
  // a fake update (and/or pre-download) for the given app(s), then remove the
  // file. The user clicks to start it and the download is then simulated.
  // Accepts a single `{ appId, mode }` or an array (mode: update|preDownload|both,
  // optional `stopAt` 0–1 to auto-pause the pre-download at that fraction).
  void (async (): Promise<void> => {
    try {
      const file = join(app.getPath('userData'), 'simulate.json')
      const raw = await fs.readFile(file, 'utf-8')
      await fs.rm(file, { force: true })
      type Spec = { appId?: string; mode?: 'update' | 'preDownload' | 'both'; stopAt?: number }
      const parsedData = JSON.parse(raw) as Spec | Spec[]
      const specs = Array.isArray(parsedData) ? parsedData : [parsedData]
      for (const spec of specs) {
        if (spec.appId) {
          registerUpdatePreview(
            spec.appId,
            spec.mode === 'update' || spec.mode === 'preDownload' || spec.mode === 'both'
              ? spec.mode
              : 'preDownload',
            spec.stopAt
          )
        }
      }
    } catch {
      /* no preview requested */
    }
  })()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(windowIcon)
  })
})

if (holdsLock || runMode !== 'app') {
  app.on('before-quit', () => {
    markQuitting()
  })

  app.on('will-quit', () => {
    runtime.dispose()
    destroyTray()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
