import { app, dialog } from 'electron'
import { handleIpc } from './access'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyLauncherIcon } from '../services/appIcon'
import { AppStore } from '../services/appStore'
import { log } from '../services/logger'
import { psQuote, runPowerShell } from '../services/powershell'
import {
  restoreSettingsBackup,
  SettingsImportRecoveryError,
  stageSettingsBackup
} from '../services/settingsBackup'
import { appUpdate, broadcast, gacha, playTime } from './context'
import { requireDataRecovery, withExclusiveDataAccess } from './dataAccess'

/**
 * Full settings backup / restore (config + playtime + gacha + icons/bg) as a
 * single zip. `data:import` overwrites the current data, so the renderer asks
 * the user to confirm first.
 */
export function registerBackupIpc(): void {
  handleIpc('data:export', async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const picked = await dialog.showSaveDialog({
      title: '导出设置',
      defaultPath: `KevinLauncher-设置备份-${stamp}.zip`,
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
    })
    if (picked.canceled || !picked.filePath) return null

    const stage = await fs.mkdtemp(join(tmpdir(), 'kl-export-'))
    try {
      await AppStore.load()
      await AppStore.save()
      await Promise.all([playTime.flush(), gacha.flush()])
      await stageSettingsBackup(app.getPath('userData'), stage)
      await runPowerShell(
        `Compress-Archive -Path ${psQuote(join(stage, '*'))} -DestinationPath ${psQuote(picked.filePath)} -Force`
      )
      log(`data: exported to ${picked.filePath}`)
      return picked.filePath
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  handleIpc('data:import', async () => {
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
        `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(out)} -Force`
      )
      await withExclusiveDataAccess(async () => {
        if (appUpdate.isRunning()) throw new Error('启动器正在更新，请完成后再导入数据')
        await Promise.all([playTime.flush(), gacha.flush()])
        try {
          await restoreSettingsBackup(out, app.getPath('userData'), async () => {
            await AppStore.reload()
            await playTime.reload()
            await gacha.reload()
          })
        } catch (error) {
          if (error instanceof SettingsImportRecoveryError) requireDataRecovery()
          throw error
        }
      })
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
