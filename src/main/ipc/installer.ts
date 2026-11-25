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
  finishUninstall,
  freeSpace,
  inspectTarget,
  installDirArgument,
  installSize,
  normalizeInstallDir,
  removeInstallation,
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
import { AppStore } from '../services/appStore'
import { currentAppVersion } from '../services/appVersion'
import { directorySize } from '../services/updateDownload'
import { appUpdate, gacha, playTime, runtime } from './context'
import { withExclusiveDataAccess } from './dataAccess'

function requireAbsoluteDirectory(value: unknown): string {
  if (typeof value !== 'string' ||
      !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/.?][^\\/]*[\\/][^\\/]+)/i.test(value.trim()) ||
      !win32.isAbsolute(value.trim())) {
    throw new Error('请选择有效的绝对目录')
  }
  return value.trim()
}

/** Installer / uninstaller UI (fresh install + `--uninstall`) and data-dir moves. */
export function registerInstallerIpc(): void {
  let installing = false
  let readyInstallDir: string | null = null
  handleIpc('installer:info', async () => {
    const detected = await detectInstallation()
    const running = await runningInstances()
    const explicit = installDirArgument()
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
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择安装位置',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current || defaultInstallDir()
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handleIpc('installer:run', async (e, requested: string, requestedDataDir?: string) => {
    if (installing) throw new Error('安装正在进行')
    const requestedPath = requireAbsoluteDirectory(requested)
    const dataPath = requestedDataDir === undefined ? undefined : requireAbsoluteDirectory(requestedDataDir)
    installing = true
    readyInstallDir = null
    try {
      readyInstallDir = await installLauncher(requestedPath, dataPath, progress => {
        if (!e.sender.isDestroyed()) e.sender.send('installer:progress', progress)
      })
      return true
    } finally {
      installing = false
    }
  })

  // --- data directory (moved by the user in the settings) -------------------
  handleIpc('dataDir:get', () => ({
    current: currentDataDir(),
    default: defaultDataDir(),
    programDir: dirname(process.execPath)
  }))
  handleIpc('dataDir:pick', async (e, current: string) => {
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
    if (process.env.KEVIN_LAUNCHER_DATA_DIR?.trim()) throw new Error('测试版使用隔离的数据目录')
    const target = await realDirectoryPath(normalizeDataDir(requireAbsoluteDirectory(dir)))
    if (directoriesOverlap(target, await realDirectoryPath(dirname(process.execPath)))) {
      throw new Error('数据目录不能与程序目录相同，也不能互相包含')
    }
    const sender = e.sender
    return withExclusiveDataAccess(async () => {
      if (appUpdate.isRunning()) throw new Error('启动器正在更新，请完成后再迁移数据')
      const resumePolling = runtime.pausePolling()
      try {
        await AppStore.load()
        await AppStore.save()
        await switchDataDir(target, async () => {
          for (const record of runtime.checkpointSessions()) await playTime.addSession(record)
          await Promise.all([playTime.flush(), gacha.flush()])
        }, (step) => {
          if (!sender.isDestroyed()) sender.send('dataDir:progress', { step })
        })
      } finally {
        resumePolling()
      }
    })
  })
  handleIpc('installer:launch', async (_e, dir: string) => {
    const target = await realDirectoryPath(normalizeInstallDir(requireAbsoluteDirectory(dir)))
    if (installing || !readyInstallDir || target.toLowerCase() !== readyInstallDir.toLowerCase()) {
      throw new Error('请选择本次已安装的启动器')
    }
    // Start it as a *launcher*, not as an installer: the portable variables are
    // inherited through the environment and would put the new process back into
    // install mode (showing another installer window instead of the app).
    const env = { ...process.env }
    delete env.PORTABLE_EXECUTABLE_FILE
    delete env.PORTABLE_EXECUTABLE_DIR
    const child = spawn(join(readyInstallDir, 'KevinLauncher.exe'), [], {
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
    const dir = dirname(process.execPath)
    const detected = await detectInstallation()
    return {
      installDir: detected?.dir ?? dir,
      version: currentAppVersion(),
      dataDir: app.getPath('userData'),
      dataSize: await directorySize(app.getPath('userData')),
      installSize: await directorySize(dir)
    }
  })
  handleIpc('uninstaller:run', async (e, keepUserData: boolean) => {
    if (typeof keepUserData !== 'boolean') throw new Error('请选择是否保留用户数据')
    const sender = e.sender
    const dir = dirname(process.execPath)
    const detected = await detectInstallation()
    await removeInstallation({
      installDir: detected?.dir ?? dir,
      keepUserData,
      onProgress: (step) => {
        if (!sender.isDestroyed()) sender.send('uninstaller:progress', { step })
      }
    })
    finishUninstall(detected?.dir ?? dir)
    markQuitting()
    app.quit()
  })
}
