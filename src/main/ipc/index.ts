import { onBeforeShutdown } from '../services/shutdown'
import { broadcast, playTime, runtime, updates } from './context'
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
export function registerIpc(): void {
  runtime.onChanged(() => broadcast('runtime:changed'))
  updates.onProgress((status) => broadcast('update:progress', status))

  void playTime.load()
  runtime.onSessionEnded((record) => {
    void playTime.addSession(record).then(() => broadcast('playtime:changed'))
  })
  // On exit, close out sessions that are still running and flush pending saves
  // so the last stretch of play time is not lost.
  onBeforeShutdown(async () => {
    for (const record of runtime.endAll()) await playTime.addSession(record)
    await playTime.flush()
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
  registerInstallerIpc()
  registerGalleryIpc()
  registerHousekeepingIpc()
  registerWindowIpc()
}
