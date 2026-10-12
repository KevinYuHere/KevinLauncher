import { BrowserWindow } from 'electron'
import { Runtime } from '../services/runtime'
import { UpdateManager } from '../update/updateManager'
import { AppUpdateChecker } from '../services/appUpdate'
import { PlayTimeStore } from '../services/playTimeStore'
import { GachaStore } from '../gacha/gachaStore'

/**
 * Process-wide singletons shared by the IPC modules. Keeping them here (rather
 * than inside a handler file) avoids import cycles between the domain modules.
 */
export const runtime = new Runtime()
export const updates = new UpdateManager()
export const appUpdate = new AppUpdateChecker()
export const playTime = PlayTimeStore.instance()
export const gacha = new GachaStore()

/** Send an event to every renderer (main window and the gallery viewer). */
export function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

export const notifyAppsChanged = (): void => broadcast('apps:changed')

export interface UpdatePreview {
  hasUpdate: boolean
  preDownloadVersion: string | null
  stopAt?: number
}

const previewApps = new Map<string, UpdatePreview>()

/**
 * Advertise a fake update/pre-download for an app so the download UI can be
 * previewed; the user still has to click, and the download is then simulated.
 */
export function registerUpdatePreview(
  appId: string,
  mode: 'update' | 'preDownload' | 'both',
  stopAt?: number
): void {
  previewApps.set(appId, {
    hasUpdate: mode === 'update' || mode === 'both',
    preDownloadVersion: mode === 'preDownload' || mode === 'both' ? '9.9.9' : null,
    stopAt
  })
}

export const getUpdatePreview = (appId: string): UpdatePreview | undefined => previewApps.get(appId)
