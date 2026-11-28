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
import { requireDiskSpace } from '../services/diskSpace'
import { log } from '../services/logger'
import { psQuote, runPowerShell } from '../services/powershell'
import { extractSettingsArchive, inspectSettingsArchive } from '../services/settingsBackupArchive'
import {
  restoreSettingsBackup,
  SettingsImportRecoveryError,
  stageSettingsBackup
} from '../services/settingsBackup'
import { appUpdate, broadcast, checkpointData, gacha, playTime, runtime } from './context'
import { advanceDataGeneration, requireDataRecovery, withExclusiveDataAccess } from './dataAccess'
import { errorText } from './util'

/**
 * Full settings backup / restore (config + playtime + gacha + icons/bg) as a
 * single zip. `data:import` overwrites the current data, so the renderer asks
 * the user to confirm first.
 */
export function registerBackupIpc(): void {
  handleIpc('data:export', async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const picked = await dialog.showSaveDialog({
      title: '导出设置备份',
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
      title: '导入设置备份',
      properties: ['openFile'],
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return null

    // Inspect the selected archive before copying it or writing any expanded
    // entry. The copy is inspected again so a changed source cannot skip the
    // limits or the path whitelist that were checked here.
    const source = picked.filePaths[0]
    const plan = await inspectSettingsArchive(source)
    const work = await fs.mkdtemp(join(tmpdir(), 'kl-import-'))
    try {
      const sourceStat = await fs.stat(source)
      if (!sourceStat.isFile() || sourceStat.size !== plan.archiveSize) {
        throw new Error('备份文件在选择后被修改，请重新选择')
      }
      const zip = join(work, 'data.zip')
      const userData = app.getPath('userData')
      await requireDiskSpace([
        { path: work, bytes: sourceStat.size + plan.expandedBytes },
        { path: userData, bytes: plan.expandedBytes }
      ])
      await fs.copyFile(source, zip)
      const copied = await inspectSettingsArchive(zip)
      await requireDiskSpace([
        { path: work, bytes: copied.expandedBytes },
        { path: userData, bytes: copied.expandedBytes }
      ])
      const out = join(work, 'out')
      await extractSettingsArchive(zip, out, copied)
      const result = await withExclusiveDataAccess(async () => {
        if (appUpdate.isRunning()) throw new Error('启动器正在更新，请等更新完成后再导入数据')
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
        const warnings = results.flatMap((result, index) =>
          result.status === 'rejected'
            ? [`${index === 0 ? '开机自启' : '启动器图标'}（${errorText(result.reason)}）`]
            : []
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
