import { BrowserWindow, clipboard, ipcMain, Menu, nativeImage, shell } from 'electron'
import { promises as fs } from 'fs'
import { extname, join } from 'path'
import type { GalleryItem } from '@shared/types'
import { AppStore } from '../services/appStore'

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

/** Single reusable image viewer window (avoid a renderer process per image). */
let viewerWindow: BrowserWindow | null = null
/** The list the viewer was opened with, so it can go to the previous/next image. */
let viewerPaths: string[] = []
let viewerIndex = 0

function showViewer(path: string): void {
  const hash = `viewer=${encodeURIComponent(path)}`
  const devUrl = process.env['ELECTRON_RENDERER_URL']

  if (viewerWindow && !viewerWindow.isDestroyed()) {
    if (devUrl) void viewerWindow.loadURL(`${devUrl}#${hash}`)
    else void viewerWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash })
    if (viewerWindow.isMinimized()) viewerWindow.restore()
    viewerWindow.show()
    viewerWindow.focus()
    return
  }

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
  viewerWindow = viewer
  viewer.on('closed', () => {
    if (viewerWindow === viewer) viewerWindow = null
  })
  viewer.setMenuBarVisibility(false)
  if (devUrl) viewer.loadURL(`${devUrl}#${hash}`)
  else viewer.loadFile(join(__dirname, '../renderer/index.html'), { hash })
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
    viewerPaths = Array.isArray(paths) ? paths.slice() : [String(paths)]
    if (viewerPaths.length === 0) return
    viewerIndex = Math.max(0, Math.min(viewerPaths.length - 1, index | 0))
    showViewer(viewerPaths[viewerIndex])
  })

  // Previous/next image (wraps). Returns the new path; the viewer window updates
  // in place (no reload).
  ipcMain.handle('gallery:viewerNav', (_e, delta: number) => {
    const n = viewerPaths.length
    if (n === 0) return null
    const step = delta < 0 ? -1 : 1
    viewerIndex = (viewerIndex + step + n) % n
    return viewerPaths[viewerIndex]
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
          if (!image.isEmpty()) copyImage(image)
        }
      }
    ])
    menu.popup({ window: win })
  })
}
