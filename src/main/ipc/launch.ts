import { handleIpc } from './access'
import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { basename, dirname, isAbsolute } from 'path'
import { defaultLaunchMethod, launchMethodById } from '@shared/appEntry'
import type { LaunchResult } from '@shared/types'
import { AppStore } from '../services/appStore'
import { Launcher, type LaunchSpec } from '../services/launcher'
import { gameInstallDirectory } from '../services/gameInstallDirectory'
import { isFileSystemRoot, realDirectoryPath } from '../services/directoryPath'
import { arknightsRecoveryPending } from '../update/arknightsCommit'
import { log } from '../services/logger'
import { playTime, runtime, updates } from './context'
import { prepareAppLaunchHud, prepareLinkedLaunchHud } from './kevinHud'

/** Runtime key for a linked-launch task (kept distinct from app ids). */
export const linkedRunKey = (id: string): string => `linked:${id}`

/**
 * Attach the HUD only to a launch that Launcher and Runtime both accepted. A
 * HUD preparation problem must never change the launch result; the renderer
 * still runs its ordinary post-launch window action when this returns false.
 */
async function withKevinHud(
  event: IpcMainInvokeEvent,
  result: LaunchResult,
  prepare: (senderId: number, window: BrowserWindow) => Promise<boolean>
): Promise<LaunchResult> {
  if (!result.ok) return result
  if (event.sender.isDestroyed()) return result
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) return result
  try {
    const prepared = await prepare(event.sender.id, window)
    return prepared ? { ...result, kevinHudStarted: true } : result
  } catch (error) {
    log(`kevinHud: could not prepare launch (${String(error)})`)
    return result
  }
}

async function launchTracked(
  key: string, name: string, spec: LaunchSpec, monitor: string[], monitorRoot: string | null,
  record = true, gameId: string | null = null
): Promise<LaunchResult> {
  const release = runtime.reserveLaunch(key)
  if (!release) return { ok: false, pid: null, elevated: false, error: '这个应用正在启动或运行中' }
  try {
    const { observation, ...result } = await Launcher.launch(spec, name)
    if (!result.ok) return result
    const directory = monitorRoot || dirname(observation.targetExecutable ?? spec.targetPath)
    if (isAbsolute(directory) && !isFileSystemRoot(directory)) {
      observation.monitorDirectory = await realDirectoryPath(directory).catch(() => undefined)
    }
    runtime.start(key, result.pid, result.elevated, monitor, record, observation, gameId)
    return result
  } finally {
    release()
  }
}

export function registerLaunchIpc(): void {
  handleIpc('apps:launch', async (e, id: string, methodId?: string) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === id)
    if (!entry) throw new Error('应用不存在，可能已被移除')
    const method = launchMethodById(entry, methodId) ?? defaultLaunchMethod(entry)
    if (!method || !method.targetPath.trim()) {
      return {
        ok: false,
        pid: null,
        elevated: false,
        error: '尚未配置启动文件，请在「模块管理 → 启动按钮」中设置'
      }
    }
    if (entry.addonId === 'arknights') {
      const directory = gameInstallDirectory(entry)
      if (directory) {
        try {
          if (await updates.isUpdatingInstall(directory)) throw new Error('游戏正在更新，请等更新完成后再启动')
          if (await arknightsRecoveryPending(directory)) throw new Error('请先完成上次中断的明日方舟更新')
        } catch (error) {
          return { ok: false, pid: null, elevated: false, error: (error as Error).message }
        }
      }
    }

    const spec: LaunchSpec = {
      targetPath: method.targetPath,
      arguments: method.arguments,
      workingDirectory: method.workingDirectory,
      runAsAdmin: method.runAsAdmin,
      environmentVariables: entry.environmentVariables
    }
    const result = await launchTracked(
      entry.id, entry.name, spec, entry.monitorProcessNames, entry.gameDirectory, true, entry.addonId
    )
    return withKevinHud(e, result, (senderId, window) =>
      prepareAppLaunchHud({
        senderId,
        window,
        appId: entry.id,
        launchPid: result.pid
      })
    )
  })

  // Linked launch: one file that starts several apps. Tracked as its own task
  // (key `linked:<id>`); it never touches an app's launch state.
  handleIpc('linked:launch', async (e, id: string, ownerAppId?: unknown) => {
    const list = await AppStore.linkedLaunches()
    const entry = list.find((item) => item.id === id)
    if (!entry) throw new Error('关联启动不存在，可能已被删除')
    if (!entry.targetPath.trim()) {
      return {
        ok: false,
        pid: null,
        elevated: false,
        error: '尚未配置启动文件，请在「关联启动」页面中设置'
      }
    }

    const spec: LaunchSpec = {
      targetPath: entry.targetPath,
      arguments: entry.arguments,
      workingDirectory: entry.workingDirectory,
      runAsAdmin: entry.runAsAdmin
    }
    const result = await launchTracked(linkedRunKey(entry.id), entry.name, spec, [basename(entry.targetPath)], null, false)
    return withKevinHud(e, result, (senderId, window) =>
      prepareLinkedLaunchHud({
        senderId,
        window,
        linkedId: entry.id,
        // A malformed hint is not treated as "no hint"; it rejects HUD authority.
        ownerAppId: ownerAppId === undefined
          ? undefined
          : typeof ownerAppId === 'string' ? ownerAppId : '',
        launchPid: result.pid
      })
    )
  })

  handleIpc('runtime:list', () => runtime.list())
  handleIpc('runtime:stop', (_e, appId: string) => runtime.stop(appId))

  handleIpc('playtime:totals', async () => {
    await playTime.load()
    return playTime.totalsMap()
  })
  handleIpc('playtime:summary', async (_e, appId: string, days?: number) => {
    await playTime.load()
    return playTime.summary(appId, days)
  })
}
