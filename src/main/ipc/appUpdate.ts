import { ipcMain } from 'electron'
import { appUpdate, broadcast } from './context'

/** Launcher self-update (GitHub Releases): status + download/install control. */
export function registerAppUpdateIpc(): void {
  appUpdate.onUpdate((info) => broadcast('app-update:available', info))
  appUpdate.onState((state) => broadcast('app-update:state', state))

  ipcMain.handle('appUpdate:status', () => appUpdate.status())
  ipcMain.handle('appUpdate:check', () => appUpdate.check('manual'))
  ipcMain.handle('appUpdate:state', () => appUpdate.stateSnapshot())
  ipcMain.handle('appUpdate:start', () => appUpdate.begin())
  ipcMain.handle('appUpdate:toggle', () => appUpdate.toggle())
}
