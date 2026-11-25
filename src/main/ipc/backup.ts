import { app, dialog } from 'electron'
import { handleIpc } from './access'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyLauncherIcon } from '../services/appIcon'
import { AppStore } from '../services/appStore'
import { applyAutoStart } from '../services/autostart'
import { setCloseToTray } from '../services/behavior'
import { createSiblingWorkspace } from '../services/directoryPath'
import { log } from '../services/logger'
import { psQuote, runPowerShell } from '../services/powershell'
import {
  restoreSettingsBackup,
  SettingsImportRecoveryError,
  stageSettingsBackup
} from '../services/settingsBackup'
import { appUpdate, broadcast, checkpointData, gacha, playTime, runtime } from './context'
import { advanceDataGeneration, requireDataRecovery, withExclusiveDataAccess } from './dataAccess'

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
    let work: string | undefined
    try {
      await withExclusiveDataAccess(async () => {
        await checkpointData()
        await stageSettingsBackup(app.getPath('userData'), stage)
      })
      work = await createSiblingWorkspace(picked.filePath, '.kevin-export-')
      const zip = join(work, 'settings.zip')
      await runPowerShell(`$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
        `[IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(stage)}, ${psQuote(zip)})`)
      await fs.rename(zip, picked.filePath)
      log(`data: exported to ${picked.filePath}`)
      return picked.filePath
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
      if (work) await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
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
      const result = await withExclusiveDataAccess(async () => {
        if (appUpdate.isRunning()) throw new Error('启动器正在更新，请完成后再导入数据')
        for (const record of runtime.checkpointSessions()) await playTime.addSession(record)
        await Promise.all([playTime.flush(), gacha.flush()])
        const reload = async (): Promise<void> => {
          await AppStore.reload()
          await playTime.reload()
          await gacha.reload()
        }
        try {
          await restoreSettingsBackup(out, app.getPath('userData'), reload)
        } catch (error) {
          if (error instanceof SettingsImportRecoveryError) requireDataRecovery(error)
          throw error
        }
        advanceDataGeneration()
        const config = await AppStore.load()
        const settings = await AppStore.launcherSettings()
        runtime.retainConfigured(new Set([
          ...config.apps.map(({ id }) => id),
          ...(config.linkedLaunches ?? []).map(({ id }) => `linked:${id}`)
        ]))
        setCloseToTray(settings.closeAction === 'tray')
        const results = await Promise.allSettled([
          applyAutoStart(settings.autoStart),
          AppStore.synchronizeLauncherIcon((iconFile) => applyLauncherIcon({ iconFile, reportFailure: true }))
        ])
        const warnings = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []
        )
        for (const warning of warnings) log(`data: imported settings, but ${warning}`)
        broadcast('apps:changed')
        broadcast('playtime:changed')
        broadcast('gacha:changed', null)
        broadcast('launcher:changed')
        log(`data: imported (${config.apps.length} apps)`)
        return { apps: config.apps.length, warnings }
      })
      return result
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  })
}
