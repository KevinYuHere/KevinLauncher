import { ipcMain } from 'electron'
import { basename } from 'path'
import { AppStore } from '../services/appStore'
import { Launcher } from '../services/launcher'
import { playTime, runtime } from './context'

export function registerLaunchIpc(): void {
  ipcMain.handle('apps:launch', async (_e, id: string) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === id)
    if (!entry) throw new Error('应用不存在')
    const result = await Launcher.launch(entry)
    if (result.ok) {
      // Elevated launches (when the launcher itself is not elevated) cannot be
      // tracked by pid; fall back to monitoring the target's own process name.
      const monitor = [...entry.monitorProcessNames]
      if (result.elevated && result.pid === null && monitor.length === 0) {
        monitor.push(basename(entry.targetPath))
      }
      runtime.start(entry.id, result.pid, result.elevated, monitor)
    }
    return result
  })

  ipcMain.handle('runtime:list', () => runtime.list())
  ipcMain.handle('runtime:stop', (_e, appId: string) => runtime.stop(appId))

  ipcMain.handle('playtime:totals', async () => {
    await playTime.load()
    return playTime.totalsMap()
  })
  ipcMain.handle('playtime:summary', async (_e, appId: string, days?: number) => {
    await playTime.load()
    return playTime.summary(appId, days)
  })
}
