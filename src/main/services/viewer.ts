import { BrowserWindow } from 'electron'
import { app } from 'electron'
import { bindWindowRole } from './windowRole'
import { isAbsolute, join } from 'path'

/**
 * A single reusable media viewer window (a renderer process per image would be
 * wasteful). Shared by the gallery and the wallpaper viewer.
 */
let viewerWindow: BrowserWindow | null = null
/** The list the viewer was opened with, so it can go to the previous/next item. */
let viewerPaths: string[] = []
let viewerIndex = 0

function showViewer(path: string): void {
  const hash = `viewer=${encodeURIComponent(path)}`
  const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL

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
    title: '查看',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true }
  })
  bindWindowRole(viewer.webContents, 'viewer', devUrl)
  viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  viewerWindow = viewer
  viewer.on('closed', () => {
    if (viewerWindow === viewer) viewerWindow = null
  })
  viewer.setMenuBarVisibility(false)
  if (devUrl) viewer.loadURL(`${devUrl}#${hash}`)
  else viewer.loadFile(join(__dirname, '../renderer/index.html'), { hash })
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
  return window !== viewerWindow || viewerPaths.includes(path)
}

/** Previous/next item (wraps). Returns the new path. */
export function viewerNav(delta: number): string | null {
  const n = viewerPaths.length
  if (n === 0) return null
  const step = delta < 0 ? -1 : 1
  viewerIndex = (viewerIndex + step + n) % n
  return viewerPaths[viewerIndex]
}
