import { powerMonitor } from 'electron'
import { onBeforeShutdown } from '../services/shutdown'
import { log } from '../services/logger'
import type { PlaySessionRecord } from '../services/playTimeStore'
import { broadcast, gacha, playTime, runtime, updates } from './context'
import { isDataRecoveryRequired, runWithDataAccess, withShutdownDataAccess } from './dataAccess'
import { registerAppsIpc } from './apps'
import { registerAppUpdateIpc } from './appUpdate'
import { registerBackupIpc } from './backup'
import { registerFontsIpc } from './fonts'
import { cancelGachaFetches, registerGachaIpc } from './gacha'
import { registerGalleryIpc } from './gallery'
import { registerHousekeepingIpc } from './housekeeping'
import { registerInstallerIpc } from './installer'
import { registerLaunchIpc } from './launch'
import { registerLinkedLaunchIpc } from './linkedLaunch'
import { registerMediaIpc } from './media'
import { registerUpdateIpc } from './update'
import { registerWallpaperIpc } from './wallpaper'
import { registerWindowIpc } from './window'

export { appUpdate, registerUpdatePreview, runtime, updates } from './context'
export { warmUpFonts } from './fonts'

function recordSessions(records: PlaySessionRecord[], flush = false): void {
  if (!records.length) return
  void runWithDataAccess('playtime:session-ended', async () => {
    for (const record of records) await playTime.addSession(record)
    if (flush) await playTime.flush()
    broadcast('playtime:changed')
  }).catch((error) => log(`playTime: could not record ended session (${String(error)})`))
}

/**
 * Registers every IPC handler and wires the cross-cutting events. Domain
 * handlers live in the sibling modules; this file only orchestrates them.
 */
export function registerIpc(mode: 'app' | 'install' | 'uninstall' = 'app'): void {
  registerInstallerIpc()
  registerWindowIpc()
  if (mode !== 'app') return

  runtime.onChanged(() => broadcast('runtime:changed'))
  updates.onProgress((status) => broadcast('update:progress', status))

  if (!isDataRecoveryRequired()) void playTime.load().catch((error) => log(`playTime: ${String(error)}`))
  runtime.onSessionEnded((record) => recordSessions([record]))
  powerMonitor.on('suspend', () => recordSessions(runtime.suspendSessions(), true))
  powerMonitor.on('resume', () => runtime.resumeObservations())
  // On exit, close out sessions that are still running and flush pending saves
  // so the last stretch of play time is not lost.
  onBeforeShutdown(async (beforeDispose) => {
    const resumePolling = runtime.pausePolling()
    try {
      await withShutdownDataAccess(async () => {
        cancelGachaFetches()
        await updates.stopTasks()
      }, async () => {
        if (!isDataRecoveryRequired()) {
          for (const record of runtime.checkpointSessions()) await playTime.addSession(record)
          const results = await Promise.allSettled([playTime.flush(), gacha.flush()])
          const failure = results.find((result) => result.status === 'rejected')
          if (failure) throw failure.reason
        }
        await beforeDispose?.()
        const disposals = await Promise.allSettled([gacha.dispose(), runtime.dispose()])
        for (const result of disposals) {
          if (result.status === 'rejected') log(`shutdown: service disposal failed (${String(result.reason)})`)
        }
      })
    } catch (error) {
      updates.resumeTasks()
      resumePolling()
      throw error
    }
  })

  registerAppsIpc()
  registerFontsIpc()
  registerLaunchIpc()
  registerLinkedLaunchIpc()
  registerWallpaperIpc()
  registerMediaIpc()
  registerBackupIpc()
  registerGachaIpc()
  registerUpdateIpc()
  registerAppUpdateIpc()
  registerGalleryIpc()
  registerHousekeepingIpc()
}
