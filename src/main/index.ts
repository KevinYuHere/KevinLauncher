import { app, shell, BrowserWindow, protocol, net } from 'electron'
import { spawn } from 'child_process'
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
// and packaged builds so config / icons / backgrounds stay shared.
app.setName('kevin-launcher')

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

// Only a single instance of the *launcher* may run. The installer/uninstaller
// deliberately skip the lock: opening the installer while the launcher runs must
// open the installer (it closes the launcher before overwriting it).
const singleInstance = runMode === 'app' ? app.requestSingleInstanceLock() : true
if (!singleInstance) app.quit()

/** Icon used for the window / taskbar (resolved once on startup). */
let windowIcon: string | undefined

/** Relaunch the current executable elevated (used by packaged builds). */
function relaunchElevated(): void {
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
  const args = process.argv.slice(1).map(quote).join(',')
  const script = `Start-Process -FilePath ${quote(process.execPath)} -ArgumentList @(${args}) -Verb RunAs`
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref()
  } catch {
    /* ignore */
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
  if (!singleInstance) return
  electronApp.setAppUserModelId('com.kevin.kevinlauncher')

  // Packaged launcher runs elevated so launching protected game clients never
  // triggers a UAC prompt and their processes can be tracked/stopped. In dev
  // this is handled by scripts/dev.ps1 (avoids an electron-vite restart loop).
  // The installer elevates itself only when the chosen directory needs it, and
  // the uninstaller never needs administrator rights.
  if (runMode === 'app' && !is.dev && !(await isElevated())) {
    relaunchElevated()
    app.quit()
    return
  }

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

if (singleInstance) {
  // A second launch (e.g. double-clicking the shortcut again) focuses this one.
  app.on('second-instance', () => showMainWindow())

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
