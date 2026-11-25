import { onBeforeShutdown } from '../services/shutdown'
import { log } from '../services/logger'
import { broadcast, gacha, playTime, runtime, updates } from './context'
import { isDataRecoveryRequired, runWithDataAccess, waitForDataTransfer } from './dataAccess'
import { registerAppsIpc } from './apps'
import { registerAppUpdateIpc } from './appUpdate'
import { registerBackupIpc } from './backup'
import { registerFontsIpc } from './fonts'
import { registerGachaIpc } from './gacha'
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

  void playTime.load()
  runtime.onSessionEnded((record) => {
    void runWithDataAccess('playtime:session-ended', async () => {
      await playTime.addSession(record)
      broadcast('playtime:changed')
    }).catch((error) => log(`playTime: could not record ended session (${String(error)})`))
  })
  // On exit, close out sessions that are still running and flush pending saves
  // so the last stretch of play time is not lost.
  onBeforeShutdown(async () => {
    await updates.stopHoYoTasks()
    await waitForDataTransfer()
    if (isDataRecoveryRequired()) return
    for (const record of runtime.endAll()) await playTime.addSession(record)
    const results = await Promise.allSettled([playTime.flush(), gacha.flush()])
    for (const result of results) {
      if (result.status === 'rejected') log(`shutdown: save failed (${String(result.reason)})`)
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
