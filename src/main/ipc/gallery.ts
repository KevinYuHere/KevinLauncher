import { BrowserWindow, clipboard, ipcMain, Menu, nativeImage, shell } from 'electron'
import { promises as fs } from 'fs'
import { extname, join } from 'path'
import type { GalleryItem } from '@shared/types'
import { AppStore } from '../services/appStore'
import { openViewer, viewerNav } from '../services/viewer'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'])
const MAX_IMAGES = 3000
const MAX_DEPTH = 6

type NativeImageType = ReturnType<typeof nativeImage.createFromPath>

/**
 * Copy an image to the clipboard across Electron versions: older builds expose
 * the synchronous `clipboard.writeImage`, newer ones reworked the clipboard into
 * the async W3C-style `clipboard.write([ClipboardItem])`.
 */
function copyImage(image: NativeImageType): void {
  const api = clipboard as unknown as {
    writeImage?: (img: NativeImageType) => void
    write?: (items: unknown[]) => Promise<void>
  }
  if (typeof api.writeImage === 'function') {
    api.writeImage(image)
    return
  }
  const ClipboardItemCtor = (
    globalThis as { ClipboardItem?: new (data: Record<string, Blob>) => unknown }
  ).ClipboardItem
  if (typeof api.write === 'function' && ClipboardItemCtor) {
    const blob = new Blob([image.toPNG() as unknown as BlobPart], { type: 'image/png' })
    void api.write([new ClipboardItemCtor({ 'image/png': blob })]).catch(() => undefined)
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
    const menu = Menu.buildFromTemplate([
      { label: '在文件资源管理器中打开', click: () => shell.showItemInFolder(path) },
      {
        label: '复制图片',
        click: () => {
          const image = nativeImage.createFromPath(path)
          if (!image.isEmpty()) copyImage(image)
        }
      }
    ])
    menu.popup({ window: win })
  })
}
