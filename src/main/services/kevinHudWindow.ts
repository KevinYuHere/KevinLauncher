import { BrowserWindow, screen, type WebContents } from 'electron'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { KevinHudFrame } from '@shared/kevinHud'
import { log } from './logger'
import {
  measureKevinHudFrameWidth,
  measureKevinHudTargetHeight,
  placeKevinHud,
  readKevinHudPositionMode,
  type KevinHudAnchor,
  type KevinHudDisplay,
  type KevinHudDisplayHint,
  type KevinHudMonitor,
  type KevinHudPlacement,
  type KevinHudPositionMode,
  type KevinHudRect
} from './kevinHudPlacement'

/** The only channel this service uses. The HUD preload listens; main only sends. */
export const KEVIN_HUD_FRAME_CHANNEL = 'kevinHud:frame'

export interface KevinHudWindowOptions {
  /**
   * The HUD-only preload. Defaults to the independent `preload/kevinHud.js`
   * next to the main bundle; the launcher's privileged preload is never used.
   */
  preloadPath?: string
  /**
   * Actual HUD document entry. Defaults to the dev server's `hud.html`
   * (`ELECTRON_RENDERER_URL`) or the packaged `renderer/hud.html`. The service
   * always appends `?kevinHud=1` for the renderer's dedicated HUD branch.
   */
  rendererUrl?: string
}

interface DisplaySnapshot {
  displays: KevinHudDisplay[]
  primaryDisplayId: number
}

/**
 * Everything that can change the native window rectangle. Telemetry updates
 * that leave these values untouched do not need to ask Electron for displays
 * or call `setBounds` again.
 */
interface PlacementInputs {
  monitor: KevinHudMonitor
  anchor: KevinHudAnchor
  x: number
  y: number
  width: number
  height: number
  positionMode: KevinHudPositionMode
  hint: string
}

function samePlacementInputs(left: PlacementInputs, right: PlacementInputs): boolean {
  return (
    left.monitor === right.monitor &&
    left.anchor === right.anchor &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.positionMode === right.positionMode &&
    left.hint === right.hint
  )
}

function isHudFrame(value: unknown): value is KevinHudFrame {
  if (!value || typeof value !== 'object') return false
  const frame = value as Partial<KevinHudFrame>
  return !!frame.config && typeof frame.config === 'object'
}

function entryUrl(override?: string): URL {
  const configured = override?.trim()
  let url: URL
  if (configured) {
    url = parseEntryUrl(configured)
  } else {
    const devServer = process.env.ELECTRON_RENDERER_URL?.trim()
    url = devServer
      ? parseEntryUrl(devServer)
      : pathToFileURL(join(__dirname, '../renderer/hud.html'))
  }

  // electron-vite exposes the dev server origin; the HUD is the dedicated
  // multi-page entry, not the launcher document. This also makes an explicit
  // origin-only override work in development.
  if (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.pathname === '' || url.pathname === '/')
  ) {
    url.pathname = '/hud.html'
  }

  if (url.protocol === 'file:') {
    if (url.host && url.host !== 'localhost') {
      throw new Error('KevinHudWindow: file entries must be local')
    }
  } else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('KevinHudWindow: rendererUrl must be an http(s) or file URL')
  }
  if (url.username || url.password) {
    throw new Error('KevinHudWindow: rendererUrl must not contain credentials')
  }
  url.searchParams.set('kevinHud', '1')
  url.hash = ''
  return url
}

function parseEntryUrl(value: string): URL {
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    if (!isAbsolute(value)) throw new Error('KevinHudWindow: invalid renderer path')
    return pathToFileURL(value)
  }
  try {
    return new URL(value)
  } catch {
    throw new Error('KevinHudWindow: rendererUrl must be an absolute URL or path')
  }
}

function preloadPath(override?: string): string {
  const value = override?.trim() || join(__dirname, '../preload/kevinHud.js')
  if (!isAbsolute(value)) throw new Error('KevinHudWindow: preloadPath must be absolute')
  return value
}

function snapshotHint(hint: KevinHudDisplayHint | null | undefined): KevinHudDisplayHint | null {
  if (!hint || typeof hint !== 'object') return null
  const displayId =
    typeof hint.displayId === 'number' && Number.isFinite(hint.displayId)
      ? hint.displayId
      : null
  const game = hint.gameWindowRect
  const gameWindowRect =
    game &&
    Number.isFinite(game.x) &&
    Number.isFinite(game.y) &&
    Number.isFinite(game.width) &&
    Number.isFinite(game.height)
      ? { x: game.x, y: game.y, width: game.width, height: game.height }
      : null
  return displayId === null && !gameWindowRect ? null : { displayId, gameWindowRect }
}

/** Stable comparison key for a display hint; the hint never leaves this module. */
function hintKey(hint: KevinHudDisplayHint | null): string {
  if (!hint) return ''
  const display = hint.displayId == null ? '' : String(hint.displayId)
  const game = hint.gameWindowRect
  return game
    ? `${display}:${game.x},${game.y},${game.width},${game.height}`
    : `${display}:`
}

/**
 * One lazily created, recyclable HUD overlay window.
 *
 * The window is transparent, frameless, non-focusable, non-interactive
 * (click-through), and always-on-top. It never loads the launcher's privileged
 * preload, accepts no navigation, and opens no child windows. Frames are pushed
 * with `kevinHud:frame`; there is no IPC receiver here.
 *
 * `display()` is the normal entry point. `send()` updates an already visible
 * HUD without creating a window. `measure()` computes exactly the placement
 * `display()` would use without opening anything, so the launcher can collapse
 * to the same rectangle first. `close()` destroys the window, drops cached
 * frames and unsubscribes from display changes; the same instance can be reused
 * by a later `display()` call.
 *
 * Phase sizing is part of the window contract:
 * - `announce`, `monitor` and `exit` all use the same target height: the
 *   configured height raised when the selected item typography plus content
 *   padding needs more room. The renderer grows a shorter plate up to that
 *   height inside this same-height native host;
 * - auto width measures the content shown by each phase (identity only during
 *   the announcement, the selected stable metric slots while monitoring);
 * - `exit` keeps the last visible width and its placement, so the reverse
 *   animation never reflows or moves as the window closes.
 *
 * The frame sent to the renderer takes both dimensions from the fitted native
 * host, so auto width, the content-height floor and a work-area safety clamp
 * all agree with what is actually on screen. The renderer can scroll inside a
 * partly fitting host without wrapping the one-row layout or growing it back.
 *
 * Display geometry is snapshotted once and refreshed only by Electron's
 * display-change events, not on every telemetry tick.
 */
export class KevinHudWindow {
  private readonly entry: URL
  private readonly preload: string

  private browserWindow: BrowserWindow | null = null
  private frame: KevinHudFrame | null = null
  private hint: KevinHudDisplayHint | null = null
  private bounds: KevinHudRect | null = null
  private loaded = false
  private screenListener: (() => void) | null = null
  private displays: DisplaySnapshot | null = null
  private applied: PlacementInputs | null = null
  private lastVisibleWidth: number | null = null

  constructor(options: KevinHudWindowOptions = {}) {
    this.preload = preloadPath(options.preloadPath)
    this.entry = entryUrl(options.rendererUrl)
  }

  /**
   * Compute the exact DIP rectangle `display(frame, hint)` would use, without
   * creating or showing a window. Call this before the HUD opens so the main
   * window's departure can target the real announcement/monitor surface. The
   * hint is explicit: a previous `display()` hint is never reused here.
   */
  measure(
    frame: KevinHudFrame,
    displayHint: KevinHudDisplayHint | null = null
  ): KevinHudRect | null {
    if (!isHudFrame(frame)) return null
    const snapshot = this.displaySnapshot()
    if (!snapshot) return null
    const hint = snapshotHint(displayHint)
    // Use exactly the same retained exit width as display(). A second HUD
    // window must never measure a different rectangle than the one it shows.
    const inputs = this.placementInputs(frame, hint)
    try {
      const placement = this.placementFor(snapshot, hint, inputs)
      return placement ? { ...placement.bounds } : null
    } catch (error) {
      log('kevin hud: measure failed', error)
      return null
    }
  }

  /**
   * Show or update the HUD for a frame. Creates the BrowserWindow on demand.
   * `displayHint` selects the game display / game-window physical rect when the
   * config's monitor is `game`. Returns the applied DIP bounds when a window is
   * available, otherwise null.
   */
  display(
    frame: KevinHudFrame,
    displayHint: KevinHudDisplayHint | null = null
  ): KevinHudRect | null {
    if (!isHudFrame(frame)) return this.getBounds()

    const existing = this.browserWindow
    if (existing && existing.isDestroyed()) this.release()
    const live = this.browserWindow
    this.frame = frame
    this.hint = snapshotHint(displayHint)

    if (live && !live.isDestroyed()) {
      this.placeAndResize(live, frame)
      this.sendLatest(live)
      return this.getBounds()
    }

    const inputs = this.placementInputs(frame)
    const snapshot = this.getDisplaySnapshot()
    if (!snapshot) {
      log('kevin hud: no display available')
      return null
    }
    const placement = this.placementFor(snapshot, this.hint, inputs)
    if (!placement) {
      log('kevin hud: no display available')
      return null
    }
    if (!this.createWindow(frame, placement, inputs)) return null
    return this.getBounds()
  }

  /**
   * Push a fresh frame to an existing HUD. Does not create a window; returns
   * false when the HUD is not currently open. The latest frame is retained and
   * sent once loading completes.
   */
  send(frame: KevinHudFrame): boolean {
    if (!isHudFrame(frame)) return false
    const win = this.browserWindow
    if (!win || win.isDestroyed()) {
      if (win) this.release()
      return false
    }
    this.frame = frame
    this.placeAndResize(win, frame)
    this.sendLatest(win)
    return true
  }

  /** Current BrowserWindow DIP bounds, or null after close / before first display. */
  getBounds(): KevinHudRect | null {
    const win = this.browserWindow
    if (!win || win.isDestroyed()) return null
    try {
      const bounds = win.getBounds()
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    } catch (error) {
      log('kevin hud: getBounds failed', error)
      return this.bounds ? { ...this.bounds } : null
    }
  }

  isOpen(): boolean {
    return !!this.browserWindow && !this.browserWindow.isDestroyed()
  }

  /**
   * Strict capability check for the HUD IPC sender. The exact live WebContents
   * instance must belong to the current HUD BrowserWindow; comparing URLs,
   * window ids, or reconstructed objects is deliberately not enough.
   */
  ownsWebContents(contents: WebContents): boolean {
    if (!contents || typeof contents !== 'object') return false
    const win = this.browserWindow
    if (!win || win.isDestroyed()) return false
    try {
      if (typeof contents.isDestroyed !== 'function' || contents.isDestroyed()) return false
      return win.webContents === contents
    } catch {
      return false
    }
  }

  /**
   * Recycle the overlay. Idempotent; safe during app shutdown and while the
   * document is still loading. The instance remains reusable.
   */
  close(): void {
    const win = this.browserWindow
    this.release()
    if (win && !win.isDestroyed()) {
      try {
        win.destroy()
      } catch (error) {
        log('kevin hud: destroy failed', error)
      }
    }
  }

  private placementInputs(
    frame: KevinHudFrame,
    hint: KevinHudDisplayHint | null = this.hint
  ): PlacementInputs {
    const exiting = frame.phase === 'exit'
    return {
      monitor: frame.config.monitor,
      anchor: frame.config.anchor,
      x: frame.config.x,
      y: frame.config.y,
      width: Math.max(
        1,
        Math.round(
          measureKevinHudFrameWidth(frame, exiting ? this.lastVisibleWidth : null)
        )
      ),
      height: measureKevinHudTargetHeight(frame),
      positionMode: readKevinHudPositionMode(frame.config),
      hint: hintKey(hint)
    }
  }

  private placementFor(
    snapshot: DisplaySnapshot,
    hint: KevinHudDisplayHint | null,
    inputs: PlacementInputs
  ): KevinHudPlacement | null {
    return placeKevinHud({
      displays: snapshot.displays,
      primaryDisplayId: snapshot.primaryDisplayId,
      displayHint: hint,
      monitor: inputs.monitor,
      anchor: inputs.anchor,
      x: inputs.x,
      y: inputs.y,
      width: inputs.width,
      height: inputs.height,
      positionMode: inputs.positionMode
    })
  }

  /**
   * Screen geometry is read once per open HUD and invalidated only by the
   * display listeners. Re-reading it for every monitor sample would add native
   * work without changing the result.
   */
  private getDisplaySnapshot(): DisplaySnapshot | null {
    if (this.displays) return this.displays
    const snapshot = this.displaySnapshot()
    if (snapshot) this.displays = snapshot
    return snapshot
  }

  private displaySnapshot(): DisplaySnapshot | null {
    try {
      const primary = screen.getPrimaryDisplay()
      const displays = screen.getAllDisplays().map((display): KevinHudDisplay => {
        let physicalBounds: KevinHudRect | undefined
        if (process.platform === 'win32') {
          try {
            const physical = screen.dipToScreenRect(null, display.bounds)
            physicalBounds = {
              x: physical.x,
              y: physical.y,
              width: physical.width,
              height: physical.height
            }
          } catch {
            // The DIP fallback in placement handles displays without a mapping.
          }
        }
        return {
          id: display.id,
          bounds: { ...display.bounds },
          workArea: { ...display.workArea },
          scaleFactor: display.scaleFactor,
          physicalBounds
        }
      })
      return { displays, primaryDisplayId: primary.id }
    } catch (error) {
      log('kevin hud: cannot read displays', error)
      return null
    }
  }

  private createWindow(
    frame: KevinHudFrame,
    placement: KevinHudPlacement,
    inputs: PlacementInputs
  ): boolean {
    let win: BrowserWindow
    try {
      win = new BrowserWindow({
        x: placement.bounds.x,
        y: placement.bounds.y,
        width: placement.bounds.width,
        height: placement.bounds.height,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        backgroundMaterial: 'none',
        focusable: false,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        closable: true,
        hasShadow: false,
        roundedCorners: false,
        thickFrame: false,
        autoHideMenuBar: true,
        alwaysOnTop: true,
        title: 'Kevin HUD',
        type: process.platform === 'win32' ? 'toolbar' : undefined,
        webPreferences: {
          preload: this.preload,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          spellcheck: false,
          backgroundThrottling: false
        }
      })
    } catch (error) {
      log('kevin hud: BrowserWindow creation failed', error)
      return false
    }

    this.browserWindow = win
    this.loaded = false
    this.bounds = { ...placement.bounds }
    if (this.applyBounds(win, placement.bounds)) this.applied = inputs
    this.rememberVisibleSize(frame)
    this.attachWindow(win)

    try {
      win.setMenuBarVisibility(false)
      win.setSkipTaskbar(true)
      win.setIgnoreMouseEvents(true)
      win.setAlwaysOnTop(true, 'screen-saver')
    } catch (error) {
      log('kevin hud: window setup failed', error)
      this.discard(win)
      return false
    }

    this.startDisplayListeners()
    try {
      const loading = win.loadURL(this.entry.href)
      void loading.catch((error) => {
        if (this.browserWindow !== win || win.isDestroyed()) return
        log('kevin hud: load failed', error)
        this.discard(win)
      })
    } catch (error) {
      log('kevin hud: load failed', error)
      this.discard(win)
      return false
    }
    return true
  }

  private attachWindow(win: BrowserWindow): void {
    const contents = win.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-redirect', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())

    contents.on('did-finish-load', () => {
      if (this.browserWindow !== win || win.isDestroyed()) return
      this.loaded = true
      this.sendLatest(win)
      this.showInactive(win)
    })
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      if (this.browserWindow !== win) return
      log('kevin hud: load failed', code, description)
      this.discard(win)
    })
    contents.on('render-process-gone', (_event, details) => {
      if (this.browserWindow !== win) return
      log('kevin hud: renderer gone', details.reason)
      this.discard(win)
    })
    win.once('closed', () => {
      if (this.browserWindow !== win) return
      this.release()
    })
  }

  private showInactive(win: BrowserWindow): void {
    try {
      if (win.isDestroyed()) return
      win.setAlwaysOnTop(true, 'screen-saver')
      if (!win.isVisible()) win.showInactive()
    } catch (error) {
      log('kevin hud: show failed', error)
    }
  }

  private placeAndResize(win: BrowserWindow, frame: KevinHudFrame): void {
    const inputs = this.placementInputs(frame)
    if (this.applied && samePlacementInputs(this.applied, inputs)) {
      this.rememberVisibleSize(frame)
      return
    }
    const snapshot = this.getDisplaySnapshot()
    if (!snapshot) return
    const placement = this.placementFor(snapshot, this.hint, inputs)
    if (!placement) return
    if (!this.applyBounds(win, placement.bounds)) return
    this.applied = inputs
    this.rememberVisibleSize(frame)
  }

  private applyBounds(win: BrowserWindow, bounds: KevinHudRect): boolean {
    try {
      if (win.isDestroyed()) return false
      const current = win.getBounds()
      if (
        current.x !== bounds.x ||
        current.y !== bounds.y ||
        current.width !== bounds.width ||
        current.height !== bounds.height
      ) {
        win.setBounds(bounds, false)
      }
      const actual = win.getBounds()
      this.bounds = {
        x: actual.x,
        y: actual.y,
        width: actual.width,
        height: actual.height
      }
      return true
    } catch (error) {
      log('kevin hud: setBounds failed', error)
      return false
    }
  }

  private rememberVisibleSize(frame: KevinHudFrame): void {
    if (frame.phase === 'exit') return
    const bounds = this.bounds
    if (!bounds) return
    if (Number.isFinite(bounds.width) && bounds.width > 0) {
      this.lastVisibleWidth = Math.round(bounds.width)
    }
  }

  private effectiveFrame(frame: KevinHudFrame): KevinHudFrame {
    const bounds = this.bounds
    if (
      !bounds ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height) ||
      bounds.width <= 0 ||
      bounds.height <= 0
    ) {
      return frame
    }
    // Width follows the fitted host so auto width and work-area clamping cannot
    // leave the plate wider than the native surface. Height follows the host
    // too: the target already includes the content typography floor, and a
    // work-area clamp may shorten it; the renderer must fill the host it was
    // actually given instead of drawing its original configured height and
    // leaving a gap (or clipping a taller minimum).
    const width = Math.max(1, Math.round(bounds.width))
    const height = Math.max(1, Math.round(bounds.height))
    if (frame.config.width === width && frame.config.height === height) return frame
    return {
      ...frame,
      config: { ...frame.config, width, height }
    }
  }

  private sendLatest(win: BrowserWindow): void {
    const frame = this.frame
    if (!this.loaded || !frame || win.isDestroyed()) return
    try {
      win.webContents.send(KEVIN_HUD_FRAME_CHANNEL, this.effectiveFrame(frame))
    } catch (error) {
      log('kevin hud: frame send failed', error)
    }
  }

  private readonly onDisplayChange = (): void => {
    // The cached snapshot and applied inputs are both stale now. The next
    // placement reads displays once; an exit keeps its retained visible width
    // and the configured height.
    this.displays = null
    this.applied = null
    const win = this.browserWindow
    const frame = this.frame
    if (!win || win.isDestroyed() || !frame) return
    this.placeAndResize(win, frame)
    this.sendLatest(win)
  }

  private startDisplayListeners(): void {
    if (this.screenListener) return
    const listener = this.onDisplayChange
    this.screenListener = listener
    try {
      screen.on('display-added', listener)
      screen.on('display-removed', listener)
      screen.on('display-metrics-changed', listener)
    } catch (error) {
      log('kevin hud: display listener setup failed', error)
      this.stopDisplayListeners()
    }
  }

  private stopDisplayListeners(): void {
    const listener = this.screenListener
    if (!listener) return
    this.screenListener = null
    try {
      screen.removeListener('display-added', listener)
      screen.removeListener('display-removed', listener)
      screen.removeListener('display-metrics-changed', listener)
    } catch (error) {
      log('kevin hud: display listener cleanup failed', error)
    }
  }

  private discard(win: BrowserWindow): void {
    if (this.browserWindow === win) this.release()
    if (!win.isDestroyed()) {
      try {
        win.destroy()
      } catch (error) {
        log('kevin hud: destroy failed', error)
      }
    }
  }

  private release(): void {
    this.browserWindow = null
    this.frame = null
    this.hint = null
    this.bounds = null
    this.loaded = false
    this.displays = null
    this.applied = null
    this.lastVisibleWidth = null
    this.stopDisplayListeners()
  }
}
