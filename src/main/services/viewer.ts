import { BrowserWindow } from 'electron'
import { app } from 'electron'
import { bindWindowRole } from './windowRole'
import { isAbsolute, join } from 'path'

/**
 * A single reusable media viewer window (a renderer process per image would be
 * wasteful). Shared by the gallery and the wallpaper viewer.
 */
let viewerDocument: { window: BrowserWindow; url: URL } | null = null
/** The list the viewer was opened with, so it can go to the previous/next item. */
let viewerPaths: string[] = []
let viewerIndex = 0

function showViewer(path: string): void {
  const hash = `viewer=${encodeURIComponent(path)}`
  const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL

  if (viewerDocument && !viewerDocument.window.isDestroyed()) {
    const { window, url } = viewerDocument
    url.hash = hash
    void window.loadURL(url.href)
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
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
    title: '查看',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true }
  })
  const url = bindWindowRole(viewer.webContents, 'viewer', devUrl)
  viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  viewerDocument = { window: viewer, url }
  viewer.on('closed', () => {
    if (viewerDocument?.window === viewer) viewerDocument = null
  })
  viewer.setMenuBarVisibility(false)
  url.hash = hash
  void viewer.loadURL(url.href)
}

/** Opens (or reuses) the viewer window at `paths[index]`. */
export function openViewer(paths: string[], index: number): void {
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !isAbsolute(path))) {
    throw new Error('请选择列表中的媒体文件')
  }
  viewerPaths = paths.slice()
  if (viewerPaths.length === 0) return
  viewerIndex = Math.max(0, Math.min(viewerPaths.length - 1, index | 0))
  showViewer(viewerPaths[viewerIndex])
}

/** Limit viewer file actions to the collection selected by the main window. */
export function permitsViewerFile(window: BrowserWindow, path: string): boolean {
  return window !== viewerDocument?.window || viewerPaths.includes(path)
}

/** Previous/next item (wraps). Returns the new path. */
export function viewerNav(delta: number): string | null {
  const n = viewerPaths.length
  if (n === 0) return null
  const step = delta < 0 ? -1 : 1
  viewerIndex = (viewerIndex + step + n) % n
  return viewerPaths[viewerIndex]
}
