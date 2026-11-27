import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { isKevinHudConfig } from '@shared/kevinHud'
import { handleIpc } from './access'
import { playTime, runtime } from './context'
import { log } from '../services/logger'
import {
  createKevinHudController,
  type KevinHudController
} from '../services/kevinHudController'

/**
 * The narrow HUD IPC domain.
 *
 * `preview` / `updateLive` / `dismissPreview` / `commitLaunch` go through
 * `handleIpc`, so they require the existing trusted `app` role and add no new
 * window privilege. `updateLive` only amends a HUD/preview/ticket the controller
 * already owns; it never opens one.
 *
 * `kevinHud:ready` is different: the dedicated HUD window is intentionally not
 * bound to the launcher's `app` role (it must never gain the privileged
 * preload), so it cannot use `handleIpc`. This one channel therefore has its own
 * strict authentication: main frame only, the exact live WebContents owned by
 * the current HUD BrowserWindow, not one of the launcher senders that owns a
 * ticket/session, and the exact HUD document URL including a per-process random
 * token. It returns only the cached frame.
 */
export const KEVIN_HUD_READY_CHANNEL = 'kevinHud:ready'

let controllerPromise: Promise<KevinHudController> | null = null
let resolvedController: KevinHudController | null = null
let registered = false
let quitHookArmed = false

function getController(): Promise<KevinHudController> {
  controllerPromise ??= createKevinHudController({
    runtime,
    playTime,
    log
  }).then((controller) => {
    resolvedController = controller
    return controller
  }).catch((error) => {
    controllerPromise = null
    throw error
  })
  return controllerPromise
}

function armQuitHook(): void {
  if (quitHookArmed) return
  quitHookArmed = true
  const dispose = (): void => {
    if (resolvedController) {
      void resolvedController.dispose().catch((error) => {
        log(`kevinHud: could not dispose at shutdown (${String(error)})`)
      })
      return
    }
    void controllerPromise?.then((controller) => controller.dispose()).catch((error) => {
      log(`kevinHud: could not dispose at shutdown (${String(error)})`)
    })
  }
  app.once('will-quit', dispose)
  // `app.exit()` paths (update / data-directory hand-off) skip `will-quit`.
  // Dispose starts synchronously (closing the overlay) before the process ends.
  process.once('exit', () => {
    if (resolvedController) void resolvedController.dispose()
  })
}

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  if (event.sender.isDestroyed()) return null
  const window = BrowserWindow.fromWebContents(event.sender)
  return window && !window.isDestroyed() ? window : null
}

function authenticateHudReady(event: IpcMainInvokeEvent, controller: KevinHudController): boolean {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame) return false
  if (event.sender.isDestroyed()) return false
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) return false
  if (!controller.ownsHudContents(event.sender)) return false
  if (controller.isMainSender(event.sender.id)) return false
  return controller.isTrustedHudPage(frame.url)
}

/**
 * Called by launch.ts only after Launcher.launch succeeded and Runtime accepted
 * the launch. Returns true when a one-shot HUD ticket was prepared; the
 * renderer still commits it after the launch transition.
 */
export async function prepareAppLaunchHud(input: {
  senderId: number
  window: BrowserWindow
  appId: string
  launchPid: number | null
}): Promise<boolean> {
  const controller = await getController()
  return controller.prepareAppLaunch({
    senderId: input.senderId,
    windowId: input.window.id,
    mainWindow: input.window,
    appId: input.appId,
    launchPid: input.launchPid
  })
}

/**
 * Linked launches are owned only through an app's persisted `linkedLaunchIds`.
 * `ownerAppId` is a renderer hint, not authority; the controller checks it
 * against AppStore and refuses an ambiguous unowned launch.
 */
export async function prepareLinkedLaunchHud(input: {
  senderId: number
  window: BrowserWindow
  linkedId: string
  ownerAppId?: string | null
  launchPid: number | null
}): Promise<boolean> {
  const controller = await getController()
  return controller.prepareLinkedLaunch({
    senderId: input.senderId,
    windowId: input.window.id,
    mainWindow: input.window,
    linkedId: input.linkedId,
    ownerAppId: input.ownerAppId,
    launchPid: input.launchPid
  })
}

/** Register the narrow HUD channels. The launcher preload alone is not enough. */
export function registerKevinHudIpc(): void {
  if (registered) return
  registered = true
  armQuitHook()

  // Warm up at startup so the first launch does not pay for dynamic imports
  // and so power-monitor/global-shortcut adapters are ready.
  void getController().catch((error) => {
    log(`kevinHud: controller unavailable (${String(error)})`)
  })

  ipcMain.handle(KEVIN_HUD_READY_CHANNEL, async (event) => {
    try {
      const controller = await getController()
      if (!authenticateHudReady(event, controller)) return null
      return controller.getLatestHudFrame()
    } catch (error) {
      log(`kevinHud: ready handshake failed (${String(error)})`)
      return null
    }
  })

  handleIpc('kevinHud:preview', async (event, appId: unknown, config: unknown) => {
    const controller = await getController()
    // `handleIpc` already proved this is the trusted launcher document. Bind
    // the preview to that sender's own BrowserWindow so its first use cannot
    // leave a HUD window keeping `window-all-closed` from firing.
    await controller.preview(appId, config, senderWindow(event))
  })

  handleIpc('kevinHud:updateLive', async (_event, appId: unknown, config: unknown) => {
    // `handleIpc` already proved this is the trusted launcher document. The
    // controller then limits the update to an app it already has a live
    // session, preview or issued ticket for; malformed configurations are
    // ignored rather than defaulting a surface to a different layout.
    if (!isKevinHudConfig(config)) return
    const controller = await getController()
    controller.updateLive(appId, config)
  })

  handleIpc('kevinHud:dismissPreview', async () => {
    const controller = await getController()
    controller.dismissPreview()
  })

  handleIpc('kevinHud:commitLaunch', async (event, runtimeKey: unknown, reducedMotion: unknown) => {
    if (typeof runtimeKey !== 'string' || typeof reducedMotion !== 'boolean') return false
    const window = senderWindow(event)
    if (!window) return false
    try {
      const controller = await getController()
      return controller.commitLaunch({
        senderId: event.sender.id,
        windowId: window.id,
        runtimeKey,
        reducedMotion
      })
    } catch (error) {
      log(`kevinHud: commit failed (${String(error)})`)
      return false
    }
  })
}
