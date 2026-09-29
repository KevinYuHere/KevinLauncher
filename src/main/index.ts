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
  setCloseToTray
} from './services/behavior'
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

function createWindow(icon?: string): void {
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
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
      void ensureTray(mainWindow)
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.kevin.kevinlauncher')

  // Packaged builds run elevated so launching protected game clients never
  // triggers a UAC prompt and their processes can be tracked/stopped. In dev
  // this is handled by scripts/dev.ps1 (avoids an electron-vite restart loop).
  if (!is.dev && !(await isElevated())) {
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
  void AppStore.launcherSettings().then((settings) =>
    setCloseToTray(settings.closeAction === 'tray')
  )
  createWindow((await launcherIconPaths()).png)
  void applyLauncherIcon()
  warmUpFonts()

  // Check GitHub Releases shortly after launch, then every 24 hours.
  appUpdate.start()

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
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

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
