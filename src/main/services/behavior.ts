import { app, BrowserWindow, Menu, Tray, nativeImage, type NativeImage } from 'electron'
import { join } from 'path'

let closeToTray = false
let quitting = false
let tray: Tray | null = null
let trayImage: NativeImage | null = null

/** Update the tray icon image (applied now if the tray exists). */
export function setTrayImage(image: NativeImage): void {
  trayImage = image
  if (tray) tray.setImage(image)
}

/** Whether the window's × hides to the tray instead of quitting. */
export function getCloseToTray(): boolean {
  return closeToTray
}
export function setCloseToTray(value: boolean): void {
  closeToTray = value
}

export function markQuitting(): void {
  quitting = true
}
export function isQuitting(): boolean {
  return quitting
}

/** Bring the main window to the foreground (creating it is the caller's job). */
export function showMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * Bundled default icon. Used when the tray is created before the configured
 * icon has been resolved — `app.getFileIcon()` must not be used as the primary
 * source because Windows returns it without an alpha channel (which shows up as
 * white corners in the notification area) and it can fail outright, leaving
 * Electron's default icon.
 */
function bundledIcon(): NativeImage {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'resources', 'icon.png')
  return nativeImage.createFromPath(path)
}

/** Create the tray icon (idempotent) with a show/quit menu. */
export async function ensureTray(): Promise<void> {
  if (tray) return

  let image = trayImage
  if (!image || image.isEmpty()) image = bundledIcon()
  if (image.isEmpty()) {
    // Last resort only; see the note above.
    try {
      image = await app.getFileIcon(process.execPath, { size: 'small' })
    } catch {
      image = nativeImage.createEmpty()
    }
  }
  // Never create a tray with an empty image: Windows would fall back to a
  // generic (Electron) icon.
  if (image.isEmpty()) return

  try {
    tray = new Tray(image)
  } catch {
    tray = null
    return
  }
  tray.setToolTip('KevinLauncher')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主界面', click: showMainWindow },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          markQuitting()
          app.quit()
        }
      }
    ])
  )
  tray.on('click', showMainWindow)
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
