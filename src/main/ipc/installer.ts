import { app, BrowserWindow, dialog } from 'electron'
import { handleIpc } from './access'
import { spawn } from 'child_process'
import { once } from 'events'
import { dirname, join, win32 } from 'path'
import { directoriesOverlap } from '@shared/paths'
import { markQuitting } from '../services/behavior'
import {
  defaultInstallDir,
  detectInstallation,
  freeSpace,
  inspectTarget,
  installDirArgument,
  installSize,
  normalizeInstallDir,
  runningInstances
} from '../services/install'
import {
  currentDataDir,
  defaultDataDir,
  normalizeDataDir,
  realDirectoryPath,
  switchDataDir
} from '../services/dataDir'
import { installLauncher } from '../services/installerFlow'
import { DataDirectoryRecoveryError } from '../services/dataMoveJournal'
import { currentAppVersion } from '../services/appVersion'
import { directorySize } from '../services/updateDownload'
import { appUpdate, checkpointData, runtime } from './context'
import { advanceDataGeneration, requireDataRecovery, withExclusiveDataAccess } from './dataAccess'
import { launcherExecutableName, trialBuild } from '../services/buildIdentity'
import { runSetupTask, setupTaskActive } from '../services/setupTask'
import { getUninstallDirectory, prepareUninstall } from '../services/uninstall'

function requireAbsoluteDirectory(value: unknown): string {
  if (typeof value !== 'string' ||
      !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/.?][^\\/]*[\\/][^\\/]+)/i.test(value.trim()) ||
      !win32.isAbsolute(value.trim())) {
    throw new Error('请选择完整的文件夹路径（例如 D:\\Games\\KevinLauncher）')
  }
  return value.trim()
}

/** Installer / uninstaller UI (fresh install + `--uninstall`) and data-dir moves. */
export function registerInstallerIpc(): void {
  let readyInstallDir: string | null = null
  let uninstallTarget: { app: string; data: string } | null = null
  handleIpc('installer:info', async () => {
    const detected = await detectInstallation()
    const running = await runningInstances()
    const explicit = trialBuild ? defaultInstallDir() : installDirArgument()
    return {
      defaultDir: defaultInstallDir(),
      detected:
        detected ??
        (running.length ? { dir: dirname(running[0]), version: null, source: 'running' as const } : null),
      target: detected ? await inspectTarget(detected.dir) : null,
      running,
      prefillDir: explicit ?? (detected ? normalizeInstallDir(detected.dir) : defaultInstallDir()),
      payloadSize: await installSize(),
      version: currentAppVersion(),
      dataDir: app.getPath('userData')
    }
  })
  handleIpc('installer:normalize', (_e, dir: string) => normalizeInstallDir(dir))
  handleIpc('installer:running', () => runningInstances())
  handleIpc('installer:inspect', (_e, dir: string) => inspectTarget(dir))
  handleIpc('installer:freeSpace', (_e, dir: string) => freeSpace(dir))
  handleIpc('installer:pickDirectory', async (e, current: string) => {
    if (trialBuild) return defaultInstallDir()
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择安装位置',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current || defaultInstallDir()
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handleIpc('installer:run', async (e, requested: string, requestedDataDir?: string) => {
    const requestedPath = requireAbsoluteDirectory(requested)
    const dataPath = requestedDataDir === undefined ? undefined : requireAbsoluteDirectory(requestedDataDir)
    return runSetupTask(async () => {
      readyInstallDir = null
      readyInstallDir = await installLauncher(requestedPath, dataPath, progress => {
        if (!e.sender.isDestroyed()) e.sender.send('installer:progress', progress)
      })
      return true
    })
  })

  // --- data directory (moved by the user in the settings) -------------------
  handleIpc('dataDir:get', () => ({
    current: currentDataDir(),
    default: defaultDataDir(),
    programDir: dirname(process.execPath)
  }))
  handleIpc('dataDir:pick', async (e, current: string) => {
    if (trialBuild) return defaultDataDir()
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择数据目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current || defaultDataDir()
    })
    return result.canceled ? null : normalizeDataDir(result.filePaths[0] ?? '')
  })
  /** Moves the data to `dir` and restarts the launcher. */
  handleIpc('dataDir:set', async (e, dir: string) => {
    if (trialBuild) throw new Error('测试版使用固定的数据目录，不能修改')
    const target = await realDirectoryPath(normalizeDataDir(requireAbsoluteDirectory(dir)))
    if (directoriesOverlap(target, await realDirectoryPath(dirname(process.execPath)))) {
      throw new Error('数据目录不能与程序目录相同，也不能互相包含')
    }
    const sender = e.sender
    return withExclusiveDataAccess(async () => {
      if (appUpdate.isRunning()) throw new Error('启动器正在更新，请等更新完成后再迁移数据')
      const resumePolling = runtime.pausePolling()
      try {
        await switchDataDir(target, checkpointData, (step) => {
          if (!sender.isDestroyed()) sender.send('dataDir:progress', { step })
        }, advanceDataGeneration)
      } catch (error) {
        if (error instanceof DataDirectoryRecoveryError) requireDataRecovery(error)
        throw error
      } finally {
        resumePolling()
      }
    })
  })
  handleIpc('installer:launch', async (_e, dir: string) => {
    const target = await realDirectoryPath(normalizeInstallDir(requireAbsoluteDirectory(dir)))
    if (setupTaskActive() || !readyInstallDir || target.toLowerCase() !== readyInstallDir.toLowerCase()) {
      throw new Error('请先完成本次安装，再启动新安装的启动器')
    }
    // Start it as a *launcher*, not as an installer: the portable variables are
    // inherited through the environment and would put the new process back into
    // install mode (showing another installer window instead of the app).
    const env = { ...process.env }
    delete env.PORTABLE_EXECUTABLE_FILE
    delete env.PORTABLE_EXECUTABLE_DIR
    const child = spawn(join(readyInstallDir, launcherExecutableName), [], {
      detached: true,
      stdio: 'ignore',
      cwd: readyInstallDir,
      env
    })
    await once(child, 'spawn')
    child.unref()
    markQuitting()
    app.quit()
  })

  // ------------------------------------------------------------- uninstaller
  handleIpc('uninstaller:info', async () => {
    const target = { app: await getUninstallDirectory(), data: await realDirectoryPath(app.getPath('userData')) }
    uninstallTarget = target
    return {
      installDir: target.app,
      version: currentAppVersion(),
      dataDir: target.data,
      dataSize: await directorySize(target.data),
      installSize: await directorySize(target.app)
    }
  })
  handleIpc('uninstaller:run', async (e, keepUserData: boolean) => {
    if (typeof keepUserData !== 'boolean') throw new Error('请先选择卸载时是否保留用户数据')
    if (!uninstallTarget) throw new Error('还没有读取到安装位置，请稍后重试')
    const confirmed = uninstallTarget
    const sender = e.sender
    const report = await runSetupTask(() => prepareUninstall({
      installDir: confirmed.app,
      dataDir: confirmed.data,
      keepUserData,
      onProgress: (step) => {
        if (!sender.isDestroyed()) sender.send('uninstaller:progress', { step })
      }
    }))
    if (!sender.isDestroyed()) sender.send('uninstaller:progress', { step: '卸载程序已启动，结果保存在 ' + report })
    markQuitting()
    app.quit()
  })
}
