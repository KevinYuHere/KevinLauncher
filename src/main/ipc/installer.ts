import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { spawn } from 'child_process'
import { dirname, join } from 'path'
import { directoriesOverlap } from '@shared/paths'
import { applyAutoStart } from '../services/autostart'
import { markQuitting } from '../services/behavior'
import {
  applyPayload,
  closeRunningInstances,
  defaultInstallDir,
  detectInstallation,
  finishUninstall,
  freeSpace,
  inspectTarget,
  installDirArgument,
  installSize,
  normalizeInstallDir,
  removeInstallation,
  runningInstances,
  writeShortcuts,
  writeUninstallEntry
} from '../services/install'
import {
  currentDataDir,
  defaultDataDir,
  normalizeDataDir,
  seedDataDir,
  switchDataDir,
  writeDataDir
} from '../services/dataDir'
import { backupUserData } from '../services/dataBackup'
import { AppStore } from '../services/appStore'
import { currentAppVersion } from '../services/appVersion'
import { directorySize } from '../services/updateDownload'
import { log } from '../services/logger'

/** Installer / uninstaller UI (fresh install + `--uninstall`) and data-dir moves. */
export function registerInstallerIpc(): void {
  ipcMain.handle('installer:info', async () => {
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
  ipcMain.handle('installer:normalize', (_e, dir: string) => normalizeInstallDir(dir))
  ipcMain.handle('installer:running', () => runningInstances())
  ipcMain.handle('installer:inspect', (_e, dir: string) => inspectTarget(dir))
  ipcMain.handle('installer:freeSpace', (_e, dir: string) => freeSpace(dir))
  ipcMain.handle('installer:pickDirectory', async (e, current: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择安装位置',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current || defaultInstallDir()
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('installer:run', async (e, requested: string, requestedDataDir?: string) => {
    const sender = e.sender
    const dir = normalizeInstallDir(requested)
    const source = dirname(process.execPath)

    // The data directory must never be the program directory (or inside it):
    // an upgrade/uninstall would otherwise delete the user's data.
    if (requestedDataDir && directoriesOverlap(dir, requestedDataDir)) {
      throw new Error('用户数据目录不能与安装目录相同，也不能互相包含')
    }

    // Snapshot the user data before the install touches anything (rotating slot,
    // overwrites the previous snapshot).
    await backupUserData(`install ${currentAppVersion()}`)

    // The installer runs elevated from the start (see index.ts), so nothing has
    // to be relaunched here: a locked executable means the instance really could
    // not be stopped — report that instead of quitting the setup.
    const free = await closeRunningInstances(dir)
    if (!free) {
      throw new Error(`无法关闭正在运行的 ${join(dir, 'KevinLauncher.exe')}，请手动退出该实例后重试`)
    }

    await applyPayload(source, dir, (progress) => {
      if (!sender.isDestroyed()) sender.send('installer:progress', { phase: 'copying', ...progress })
    })
    if (!sender.isDestroyed()) {
      sender.send('installer:progress', { phase: 'shortcuts', done: 0, total: 0, current: '' })
    }
    writeShortcuts(dir)
    await writeUninstallEntry(dir, currentAppVersion())

    // Remember the chosen data directory. Only a fresh/empty target is seeded
    // from the default directory — re-running the installer against the user's
    // existing data directory must never overwrite it with older data.
    if (requestedDataDir) {
      const target = normalizeDataDir(requestedDataDir)
      const fallback = defaultDataDir()
      if (target.toLowerCase() !== fallback.toLowerCase()) {
        const { copied, failed, keptExisting } = await seedDataDir(target, fallback)
        if (keptExisting) {
          log(`install: kept existing data directory ${target} (default left untouched)`)
        } else if (copied > 0 && failed === 0) {
          log(`install: migrated ${copied} item(s) from ${fallback}`)
        }
        await writeDataDir(target)
        log(`install: data directory set to ${target}`)
      } else {
        await writeDataDir(fallback)
      }
    }

    // Autostart defaults to ON after a fresh install (scheduled task, silent UAC).
    await AppStore.setLauncher({ autoStart: 'window' })
    await applyAutoStart('window')
    log(`install: finished (${dir})`)
    return true
  })

  // --- data directory (moved by the user in the settings) -------------------
  ipcMain.handle('dataDir:get', () => ({
    current: currentDataDir(),
    default: defaultDataDir(),
    programDir: dirname(process.execPath)
  }))
  ipcMain.handle('dataDir:pick', async (e, current: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择数据目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current || defaultDataDir()
    })
    return result.canceled ? null : normalizeDataDir(result.filePaths[0] ?? '')
  })
  /** Moves the data to `dir` and restarts the launcher. */
  ipcMain.handle('dataDir:set', (e, dir: string) => {
    const target = normalizeDataDir(dir)
    if (directoriesOverlap(target, dirname(process.execPath))) {
      throw new Error('数据目录不能与程序目录相同，也不能互相包含')
    }
    const sender = e.sender
    return switchDataDir(target, (step) => {
      if (!sender.isDestroyed()) sender.send('dataDir:progress', { step })
    })
  })
  ipcMain.handle('installer:launch', async (_e, dir: string) => {
    // Start it as a *launcher*, not as an installer: the portable variables are
    // inherited through the environment and would put the new process back into
    // install mode (showing another installer window instead of the app).
    const env = { ...process.env }
    delete env.PORTABLE_EXECUTABLE_FILE
    delete env.PORTABLE_EXECUTABLE_DIR
    spawn(join(dir, 'KevinLauncher.exe'), [], {
      detached: true,
      stdio: 'ignore',
      cwd: dir,
      env
    }).unref()
    markQuitting()
    app.quit()
  })

  // ------------------------------------------------------------- uninstaller
  ipcMain.handle('uninstaller:info', async () => {
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
  ipcMain.handle('uninstaller:run', async (e, keepUserData: boolean) => {
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
