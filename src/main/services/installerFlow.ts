import { app } from 'electron'
import { dirname, join } from 'path'
import { directoriesOverlap } from '@shared/paths'
import type { InstallerProgress } from '@shared/types'
import {
  applyPayload, closeRunningInstances, normalizeInstallDir,
  writeShortcuts, writeUninstallEntry
} from './install'
import { backupDataDirectory, estimateBackupBytes, requireBackup } from './dataBackup'
import {
  currentDataDir, defaultDataDir, hasData, normalizeDataDir, realDirectoryPath, seedDataDir, writeDataDir
} from './dataDir'
import { currentAppVersion } from './appVersion'
import { AppStore } from './appStore'
import { applyAutoStart } from './autostart'
import { log } from './logger'
import { assertTrialInstallDirectory, launcherExecutableName, trialBuild } from './buildIdentity'
import { requireDiskSpace } from './diskSpace'
import { directorySize } from './updateDownload'

export async function installLauncher(
  requested: string,
  dataPath: string | undefined,
  onProgress: (progress: InstallerProgress) => void
): Promise<string> {
  const normalized = normalizeInstallDir(requested)
  assertTrialInstallDirectory(normalized)
  const dir = await realDirectoryPath(normalized)
  const source = await realDirectoryPath(dirname(process.execPath))
  const current = await realDirectoryPath(currentDataDir())
  const defaultDirectory = await realDirectoryPath(defaultDataDir())
  const inputDirectory = await realDirectoryPath(dataPath ?? current)
  if (trialBuild && current.toLowerCase() !== inputDirectory.toLowerCase()) {
    throw new Error('本地试用版只能使用固定的试用数据目录')
  }
  const existingPath = [current, defaultDirectory].some(
    (path) => path.toLowerCase() === inputDirectory.toLowerCase()
  )
  const target = !dataPath || existingPath
    ? inputDirectory
    : await realDirectoryPath(normalizeDataDir(dataPath))

  if (directoriesOverlap(dir, target) || directoriesOverlap(dir, current)) {
    throw new Error('用户数据目录不能与安装目录相同，也不能互相包含')
  }
  if (directoriesOverlap(dir, source)) throw new Error('安装目录与安装包暂存目录不能互相包含')

  await applyPayload(source, dir, progress => onProgress({ phase: 'copying', ...progress }), {
    beforeStage: async programSpace => {
      if (!(await closeRunningInstances(dir))) {
        throw new Error('安装器未能确认当前启动器已正常退出，请重试安装。')
      }
      // Once the old instance closes, it can no longer race with the backup.
      const reason = `install ${currentAppVersion()}`
      const moving = current.toLowerCase() !== target.toLowerCase()
      const currentBytes = await estimateBackupBytes(current)
      const targetBytes = moving ? await estimateBackupBytes(target) : 0
      const dataStage = moving && !await hasData(target) ? await directorySize(target) + currentBytes : 0
      await requireDiskSpace([
        ...programSpace,
        { path: current, bytes: currentBytes },
        { path: target, bytes: targetBytes + dataStage }
      ])
      requireBackup(await backupDataDirectory(current, reason))
      if (moving) requireBackup(await backupDataDirectory(target, reason))
    },
    afterCommit: async freshInstall => {
      onProgress({ phase: 'shortcuts', done: 0, total: 0, current: '' })
      writeShortcuts(dir)
      await writeUninstallEntry(dir, currentAppVersion())
      if (trialBuild) return
      await seedDataDir(target, currentDataDir(), writeDataDir)
      app.setPath('userData', target)
      if (freshInstall) {
        await AppStore.reload()
        await AppStore.setLauncher({ autoStart: 'window' })
        await applyAutoStart('window', join(dir, launcherExecutableName))
      }
    }
  })
  log(`install: finished (${dir})`)
  return dir
}
