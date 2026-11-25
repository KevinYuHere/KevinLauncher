import { BrowserWindow, ClipboardItem, clipboard, Menu, nativeImage, shell } from 'electron'
import { handleIpc } from './access'
import { extname } from 'path'
import { AppStore } from '../services/appStore'
import { collectGalleryImages, IMAGE_EXT } from '../services/gallery'
import { log } from '../services/logger'
import { openViewer, permitsViewerFile, viewerNav } from '../services/viewer'

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

export function registerGalleryIpc(): void {
  handleIpc('gallery:list', async (_e, appId: string) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === appId)
    const dir = entry?.screenshotDirectory
    if (!dir) return []
    return collectGalleryImages(dir)
  })

  handleIpc('gallery:openViewer', (_e, paths: string[] | string, index: number) => {
    openViewer(Array.isArray(paths) ? paths : [String(paths)], index)
  })

  // Previous/next image (wraps). Returns the new path; the viewer window updates
  // in place (no reload).
  handleIpc('gallery:viewerNav', (_e, delta: number) => viewerNav(delta))

  handleIpc('gallery:contextMenu', (e, path: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || typeof path !== 'string' || !permitsViewerFile(win, path)) return
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
