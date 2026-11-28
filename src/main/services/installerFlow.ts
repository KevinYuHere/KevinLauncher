import { app } from 'electron'
import { dirname, join } from 'path'
import { directoriesOverlap } from '@shared/paths'
import type { InstallerProgress } from '@shared/types'
import {
  applyPayload, closeRunningInstances, installedVersion, normalizeInstallDir,
  writeShortcuts, writeUninstallEntry
} from './install'
import { backupDataDirectory, estimateBackupBytes, requireBackup } from './dataBackup'
import {
  currentDataDir, defaultDataDir, hasData, normalizeDataDir, realDirectoryPath, seedDataDir, writeDataDir
} from './dataDir'
import { currentAppVersion } from './appVersion'
import { clearUpgradeSource, recordUpgradeSource } from './appActivation'
import { AppStore } from './appStore'
import { applyAutoStart } from './autostart'
import { log } from './logger'
import { compareVersions, isSemVerVersion } from '@shared/version'
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
      // Once the old instance closes, it can no longer race with the backup or
      // change the version pointer we are about to record.
      const version = currentAppVersion()
      const previous = await installedVersion(dir)
      const reason = `install ${version}`
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

      // Leave a real proof before any program directory is switched. When the
      // installer also moves the data directory, write the same proof to both
      // sides so the migration can never resurrect a stale proof from the old
      // directory and overwrite the new one.
      const proofDirs = moving ? [current, target] : [target]
      try {
        if (isSemVerVersion(previous) && isSemVerVersion(version)) {
          const comparison = compareVersions(previous, version)
          if (comparison < 0) {
            for (const dataDir of proofDirs) {
              await recordUpgradeSource(dataDir, previous, version, 'install')
            }
          } else if (comparison > 0) {
            for (const dataDir of proofDirs) await clearUpgradeSource(dataDir)
          }
        } else {
          // Fresh install or an unreadable/foreign pointer: no upgrade proof.
          for (const dataDir of proofDirs) await clearUpgradeSource(dataDir)
        }
      } catch (error) {
        throw new Error('无法记录升级来源，安装已停止', { cause: error })
      }
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
