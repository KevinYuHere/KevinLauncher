import { app, dialog, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyLauncherIcon } from '../services/appIcon'
import { AppStore } from '../services/appStore'
import { log } from '../services/logger'
import { psQuote, runPowerShell } from '../services/powershell'
import { broadcast, gacha, playTime } from './context'
import { restoreBackup, stageBackup } from './util'

/**
 * Full settings backup / restore (config + playtime + gacha + icons/bg) as a
 * single zip. `data:import` overwrites the current data, so the renderer asks
 * the user to confirm first.
 */
export function registerBackupIpc(): void {
  ipcMain.handle('data:export', async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const picked = await dialog.showSaveDialog({
      title: '导出设置',
      defaultPath: `KevinLauncher-设置备份-${stamp}.zip`,
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
    })
    if (picked.canceled || !picked.filePath) return null

    const stage = await fs.mkdtemp(join(tmpdir(), 'kl-export-'))
    try {
      await stageBackup(app.getPath('userData'), stage)
      await runPowerShell(
        `Compress-Archive -Path ${psQuote(join(stage, '*'))} -DestinationPath ${psQuote(picked.filePath)} -Force`
      )
      log(`data: exported to ${picked.filePath}`)
      return picked.filePath
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  ipcMain.handle('data:import', async () => {
    const picked = await dialog.showOpenDialog({
      title: '导入设置',
      properties: ['openFile'],
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return null

    const work = await fs.mkdtemp(join(tmpdir(), 'kl-import-'))
    try {
      const zip = join(work, 'data.zip')
      await fs.copyFile(picked.filePaths[0], zip)
      const out = join(work, 'out')
      await runPowerShell(
        `Expand-Archive -Path ${psQuote(zip)} -DestinationPath ${psQuote(out)} -Force`
      )
      await restoreBackup(out, app.getPath('userData'))
      await AppStore.reload()
      await playTime.reload()
      gacha.reload()
      await applyLauncherIcon()
      broadcast('apps:changed')
      broadcast('playtime:changed')
      broadcast('launcher:changed')
      const config = await AppStore.load()
      log(`data: imported (${config.apps.length} apps)`)
      return { apps: config.apps.length }
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  })
}
