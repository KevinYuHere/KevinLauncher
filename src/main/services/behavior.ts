import { app, BrowserWindow, Menu, Tray, nativeImage, type NativeImage } from 'electron'

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

/** Create the tray icon (idempotent) with a show/quit menu. */
export async function ensureTray(win: BrowserWindow): Promise<void> {
  if (tray) return
  let image = trayImage
  if (!image) {
    try {
      image = await app.getFileIcon(process.execPath, { size: 'small' })
    } catch {
      image = nativeImage.createEmpty()
    }
  }
  try {
    tray = new Tray(image)
  } catch {
    tray = null
    return
  }
  tray.setToolTip('KevinLauncher')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示主界面',
        click: () => {
          win.show()
          win.focus()
        }
      },
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
  tray.on('click', () => {
    win.show()
    win.focus()
  })
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
