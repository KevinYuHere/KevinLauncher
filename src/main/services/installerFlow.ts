import { app } from 'electron'
import { dirname, join } from 'path'
import { directoriesOverlap } from '@shared/paths'
import type { InstallerProgress } from '@shared/types'
import {
  applyPayload, closeRunningInstances, normalizeInstallDir,
  writeShortcuts, writeUninstallEntry
} from './install'
import { backupUserData } from './dataBackup'
import {
  currentDataDir, defaultDataDir, normalizeDataDir, realDirectoryPath, seedDataDir, writeDataDir
} from './dataDir'
import { currentAppVersion } from './appVersion'
import { AppStore } from './appStore'
import { applyAutoStart } from './autostart'
import { log } from './logger'

export async function installLauncher(
  requested: string,
  dataPath: string | undefined,
  onProgress: (progress: InstallerProgress) => void
): Promise<string> {
  const dir = await realDirectoryPath(normalizeInstallDir(requested))
  const source = await realDirectoryPath(dirname(process.execPath))
  const current = await realDirectoryPath(currentDataDir())
  const defaultDirectory = await realDirectoryPath(defaultDataDir())
  const inputDirectory = await realDirectoryPath(dataPath ?? current)
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
    beforeStage: async () => {
      if (!(await closeRunningInstances(dir))) {
        throw new Error(`无法关闭正在运行的 ${join(dir, 'KevinLauncher.exe')}，请手动退出该实例后重试`)
      }
      // Once the old instance closes, it can no longer race with the backup.
      await backupUserData(`install ${currentAppVersion()}`)
    },
    afterCommit: async freshInstall => {
      onProgress({ phase: 'shortcuts', done: 0, total: 0, current: '' })
      writeShortcuts(dir)
      await writeUninstallEntry(dir, currentAppVersion())
      await seedDataDir(target, currentDataDir(), writeDataDir)
      app.setPath('userData', target)
      if (freshInstall) {
        await AppStore.reload()
        await AppStore.setLauncher({ autoStart: 'window' })
        await applyAutoStart('window', join(dir, 'KevinLauncher.exe'))
      }
    }
  })
  log(`install: finished (${dir})`)
  return dir
}
