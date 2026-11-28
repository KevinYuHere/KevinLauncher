import { app, shell, BrowserWindow, protocol } from 'electron'
import { promises as fs } from 'fs'
import { join, basename } from 'path'
import { bindWindowRole } from './services/windowRole'
import { observeWindowActivity } from './services/windowActivity'
import { serveMediaFile } from './services/mediaProtocol'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc, registerUpdatePreview, runtime, warmUpFonts, appUpdate } from './ipc'
import { requireDataRecovery } from './ipc/dataAccess'
import { AppStore } from './services/appStore'
import { recoverDataMove } from './services/dataMoveJournal'
import { applyLauncherIcon, launcherIconPaths } from './services/appIcon'
import {
  destroyTray,
  cancelQuitting,
  ensureTray,
  getCloseToTray,
  isQuitting,
  markQuitting,
  notifyWindowShown,
  setCloseToTray,
  setMainWindowProvider,
  showMainWindow
} from './services/behavior'
import { applyAutoStart, startedHidden } from './services/autostart'
import { applyDataDir } from './services/dataDir'
import { cleanUpdateStaging } from './services/housekeeping'
import { flushBeforeShutdown } from './services/shutdown'
import { recoverSettingsImport } from './services/settingsBackup'
import { BgStore } from './services/background'
import { BrandStore } from './services/brand'
import { IconStore } from './services/icon'
import { ensureAdministrator, isElevated } from './services/elevation'
import { log } from './services/logger'
import { launcherAppId, launcherDisplayName, trialBuild } from './services/buildIdentity'
import { isolateSetupSession, setupTaskActive } from './services/setupTask'
import windowsLayout from '@shared/windowsLayout.json'
import { recordApplicationStartup } from './services/appActivation'
import { broadcast } from './ipc/context'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kevin-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      // So the renderer can draw these images to a canvas without tainting it
      // (used to sample the background's average colour for the foreground).
      corsEnabled: true
    }
  }
])

// Keep the same userData directory (`%APPDATA%\kevin-launcher`) for both dev
// and packaged builds so config / icons / backgrounds stay shared. A custom
// directory (chosen in the installer or in the settings) is stored in the
// registry and applied here, before anything reads `app.getPath('userData')`.
app.setName(trialBuild ? 'kevin-launcher-trial' : 'kevin-launcher')
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
if (runMode !== 'app') isolateSetupSession()

/** Icon used for the window / taskbar (resolved once on startup). */
let windowIcon: string | undefined


/** Window size / role of the current run. */
function createWindow(icon?: string, hidden = false, mode: RunMode = 'app'): BrowserWindow {
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
    title: launcherDisplayName,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true
    }
  })

  const devUrl = is.dev ? process.env.ELECTRON_RENDERER_URL : undefined
  const renderer = bindWindowRole(mainWindow.webContents, mode, devUrl)
  if (!setup) {
    observeWindowActivity(mainWindow, hidden, (foreground) => runtime.setForeground(foreground))
  }
  if (!setup && process.platform === 'win32' && app.isPackaged) {
    mainWindow.hookWindowMessage(windowsLayout.setupCloseMessage, () => {
      setImmediate(() => {
        log('setup: received launcher close request')
        app.quit()
      })
    })
  }
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
    notifyWindowShown(mainWindow)
  })
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized', true))
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized', false))

  mainWindow.on('close', (event) => {
    if (setup && setupTaskActive()) {
      event.preventDefault()
      return
    }
    if (getCloseToTray() && !isQuitting()) {
      event.preventDefault()
      mainWindow.hide()
      void ensureTray()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (setup || !devUrl) renderer.hash = mode
  mainWindow.loadURL(renderer.href)
  return mainWindow
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId(launcherAppId)

  // A lightweight update may run on a legacy shell with an asInvoker manifest.
  // Hand off before taking the instance lock, binding IPC or opening any window.
  // The trial's public entry requests elevation; its private runtime never relaunches itself.
  if (app.isPackaged && !(await (trialBuild ? isElevated() : ensureAdministrator(runMode)))) {
    app.quit()
    return
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
    if (app.isPackaged) recordApplicationStartup()
    app.on('second-instance', showMainWindow)
  }
  log(`app: mode=${runMode} packaged=${app.isPackaged} dev=${is.dev}`)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Serves images / videos from the launcher's `bg` / `icons` / `brand` dirs, the
  // bundled defaults, and any absolute file path (gallery):
  // kevin-media://file/<base64url>. Range support keeps large video backgrounds
  // playable, and CORS lets the renderer draw them to a canvas (untainted).
  protocol.handle('kevin-media', (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'file') {
      const encoded = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const filePath = Buffer.from(encoded, 'base64url').toString('utf8')
      return serveMediaFile(filePath, request)
    }
    const name = basename(decodeURIComponent(url.pathname))
    if (url.hostname === 'default') {
      // Bundled assets (default launcher icon) next to the app resources.
      const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
      return serveMediaFile(join(root, name), request)
    }
    const dir =
      url.hostname === 'icon'
        ? IconStore.dir()
        : url.hostname === 'brand'
          ? BrandStore.dir()
          : BgStore.bgDir()
    return serveMediaFile(join(dir, name), request)
  })

  void isElevated().then((elevated) => log(`app: administrator=${elevated}`))

  const mode = runMode
  let recoveryFailed = false
  if (mode === 'app') {
    try {
      await recoverDataMove(app.getPath('userData'))
      await recoverSettingsImport(app.getPath('userData'))
    } catch (error) {
      log(`startup: could not recover an interrupted data transfer (${String(error)})`)
      requireDataRecovery(error)
      recoveryFailed = true
    }
  }
  registerIpc(mode)
  registerQuitHandlers()
  if (mode === 'app') {
    // Release-payload actions wait for a healthy, visible main window.
    windowIcon = (await launcherIconPaths(recoveryFailed ? null : undefined)).png
  }
  // `startedHidden()` is true when the Run entry launched us with `--tray`.
  if (mode === 'app') {
    let main = createWindow(windowIcon, !recoveryFailed && startedHidden(), mode)
    setMainWindowProvider(() => {
      if (main.isDestroyed()) main = createWindow(windowIcon)
      return main
    })
  } else createWindow(windowIcon, false, mode)

  // In install / uninstall mode the app is just a small setup UI: no tray, no
  // autostart, no update checking.
  if (mode !== 'app' || recoveryFailed) return

  const launcherSettings = await AppStore.launcherSettings().catch((error) => {
    log(`startup: user configuration is unavailable (${String(error)})`)
    return null
  })
  if (launcherSettings) {
    setCloseToTray(launcherSettings.closeAction === 'tray')
    void applyAutoStart(launcherSettings.autoStart).catch(() => undefined)
  }

  // Icons first (window + tray image), then the tray itself: creating the tray
  // before the icon is resolved would leave it with a generic image.
  if (launcherSettings) {
    try {
      await AppStore.synchronizeLauncherIcon((iconFile) => applyLauncherIcon({ iconFile, reportFailure: true }))
    } catch (error) {
      log(`startup: retained the previous launcher icons (${String(error)})`)
    }
  }
  await ensureTray()
  warmUpFonts()

  // Check GitHub Releases shortly after launch, then every 24 hours.
  appUpdate.start()
  // Drop staged update downloads that are not for the running version.
  void cleanUpdateStaging()
  // Arknights apply-staging leftovers (a killed update can leave GBs behind).
  // One-shot download-UI preview: if `%userData%/simulate.json` exists, advertise
  // a fake update (and/or pre-download) for the given app(s), then remove the
  // file. The user clicks to start it and the download is then simulated.
  // Accepts a single `{ appId, mode }` or an array (mode: update|preDownload|both,
  // optional `stopAt` 0–1 to auto-pause the pre-download at that fraction).
  if (trialBuild) void (async (): Promise<void> => {
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

  app.on('activate', showMainWindow)
})

function registerQuitHandlers(): void {
  let state: 'ready' | 'flushing' | 'flushed' = 'ready'
  app.on('before-quit', (event) => {
    if (setupTaskActive()) {
      event.preventDefault()
      return
    }
    markQuitting()
    // Flush play-time (and close out running sessions) before exiting. The
    // handler prevents the first quit, flushes, then quits for real.
    if (state === 'flushed') return
    event.preventDefault()
    if (state === 'flushing') return
    state = 'flushing'
    void flushBeforeShutdown().then(() => {
      state = 'flushed'
      app.quit()
    }).catch((error: unknown) => {
      state = 'ready'
      cancelQuitting()
      showMainWindow()
      broadcast('app:shutdownFailed', error instanceof Error ? error.message : String(error))
    })
  })

  app.on('will-quit', () => {
    void runtime.dispose()
    destroyTray()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
