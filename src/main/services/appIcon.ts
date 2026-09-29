import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import { AppStore } from './appStore'
import { BrandStore } from './brand'
import { setTrayImage } from './behavior'

function bundledIcon(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(app.getAppPath(), 'resources', name)
}

function shortcutCandidates(): string[] {
  const list: string[] = []
  if (process.env.APPDATA) {
    list.push(
      join(process.env.APPDATA, 'Microsoft\\Windows\\Start Menu\\Programs\\KevinLauncher.lnk')
    )
  }
  if (process.env.PROGRAMDATA) {
    list.push(
      join(process.env.PROGRAMDATA, 'Microsoft\\Windows\\Start Menu\\Programs\\KevinLauncher.lnk')
    )
  }
  if (process.env.USERPROFILE) list.push(join(process.env.USERPROFILE, 'Desktop\\KevinLauncher.lnk'))
  if (process.env.PUBLIC) list.push(join(process.env.PUBLIC, 'Desktop\\KevinLauncher.lnk'))
  return list
}

/**
 * PNG (window / tray) and ICO (shortcuts / exe) of the current launcher icon.
 * Falls back to the icon bundled with the app.
 */
export async function launcherIconPaths(): Promise<{ png: string; ico: string }> {
  try {
    const settings = await AppStore.launcherSettings()
    if (settings.iconFile) {
      const png = join(BrandStore.dir(), settings.iconFile)
      await fs.access(png)
      return { png, ico: join(BrandStore.dir(), settings.iconFile.replace(/\.png$/i, '.ico')) }
    }
  } catch {
    /* fall back to the bundled default */
  }
  return { png: bundledIcon('icon.png'), ico: bundledIcon('icon.ico') }
}

/**
 * Apply the launcher icon to every window (taskbar / Alt-Tab), the tray, and
 * any Start Menu / Desktop shortcuts.
 */
export async function applyLauncherIcon(): Promise<void> {
  const { png, ico } = await launcherIconPaths()

  const image = nativeImage.createFromPath(png)
  if (!image.isEmpty()) {
    for (const win of BrowserWindow.getAllWindows()) win.setIcon(image)
    setTrayImage(image)
  }

  for (const path of shortcutCandidates()) {
    try {
      if (!existsSync(path)) continue
      const details = shell.readShortcutLink(path)
      shell.writeShortcutLink(path, 'update', { ...details, icon: ico, iconIndex: 0 })
    } catch {
      /* ignore shortcuts we cannot edit */
    }
  }
}
