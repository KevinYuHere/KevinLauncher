import { BrowserWindow, ClipboardItem, clipboard, ipcMain, Menu, nativeImage, shell } from 'electron'
import { promises as fs } from 'fs'
import { extname, join } from 'path'
import type { GalleryItem } from '@shared/types'
import { AppStore } from '../services/appStore'
import { log } from '../services/logger'
import { openViewer, viewerNav } from '../services/viewer'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'])
const MAX_IMAGES = 3000
const MAX_DEPTH = 6

type NativeImageType = ReturnType<typeof nativeImage.createFromPath>

/**
 * Copy an image to the system clipboard. Electron 44's clipboard only exposes the
 * W3C-style `write(ClipboardItem[])` (the old `clipboard.writeImage` was removed,
 * and `ClipboardItem` is not a global in the main process), so build a PNG entry
 * from the native image.
 */
function copyImage(image: NativeImageType): void {
  try {
    const blob = new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' })
    void clipboard.write([new ClipboardItem({ 'image/png': blob })])
  } catch (error) {
    log(`gallery: copy image failed (${(error as Error).message})`)
  }
}

async function collectImages(dir: string, out: GalleryItem[], depth = 0): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_IMAGES) return
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_IMAGES) return
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

export function registerGalleryIpc(): void {
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

  ipcMain.handle('gallery:openViewer', (_e, paths: string[] | string, index: number) => {
    openViewer(Array.isArray(paths) ? paths : [String(paths)], index)
  })

  // Previous/next image (wraps). Returns the new path; the viewer window updates
  // in place (no reload).
  ipcMain.handle('gallery:viewerNav', (_e, delta: number) => viewerNav(delta))

  ipcMain.handle('gallery:contextMenu', (e, path: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    const isImage = IMAGE_EXT.has(extname(path).toLowerCase())
    const template = [
      { label: '在文件资源管理器中打开', click: () => shell.showItemInFolder(path) }
    ] as Electron.MenuItemConstructorOptions[]
    // "复制图片" only makes sense for a still image — the wallpaper viewer reuses
    // this menu and a wallpaper may be a video (nativeImage would be empty).
    if (isImage) {
      template.push({
        label: '复制图片',
        click: () => {
          const image = nativeImage.createFromPath(path)
          if (!image.isEmpty()) copyImage(image)
        }
      })
    }
    Menu.buildFromTemplate(template).popup({ window: win })
  })
}
