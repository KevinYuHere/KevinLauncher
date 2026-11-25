import { handleIpc } from './access'
import { basename, dirname, isAbsolute } from 'path'
import { defaultLaunchMethod, launchMethodById } from '@shared/appEntry'
import type { LaunchResult } from '@shared/types'
import { AppStore } from '../services/appStore'
import { Launcher, type LaunchSpec } from '../services/launcher'
import { gameInstallDirectory } from '../services/gameInstallDirectory'
import { isFileSystemRoot, realDirectoryPath } from '../services/directoryPath'
import { arknightsRecoveryPending } from '../update/arknightsCommit'
import { playTime, runtime, updates } from './context'

/** Runtime key for a linked-launch task (kept distinct from app ids). */
export const linkedRunKey = (id: string): string => `linked:${id}`

async function launchTracked(
  key: string, name: string, spec: LaunchSpec, monitor: string[], monitorRoot: string | null, record = true
): Promise<LaunchResult> {
  const release = runtime.reserveLaunch(key)
  if (!release) return { ok: false, pid: null, elevated: false, error: '已有启动请求或正在运行' }
  try {
    const { observation, ...result } = await Launcher.launch(spec, name)
    if (!result.ok) return result
    const directory = monitorRoot || dirname(observation.targetExecutable ?? spec.targetPath)
    if (isAbsolute(directory) && !isFileSystemRoot(directory)) {
      observation.monitorDirectory = await realDirectoryPath(directory).catch(() => undefined)
    }
    runtime.start(key, result.pid, result.elevated, monitor, record, observation)
    return result
  } finally {
    release()
  }
}

export function registerLaunchIpc(): void {
  handleIpc('apps:launch', async (_e, id: string, methodId?: string) => {
    const store = await AppStore.load()
    const entry = store.apps.find((a) => a.id === id)
    if (!entry) throw new Error('应用不存在')
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
          if (await updates.isUpdatingInstall(directory)) throw new Error('游戏正在更新，请等更新完成')
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
    return launchTracked(entry.id, entry.name, spec, entry.monitorProcessNames, entry.gameDirectory)
  })

  // Linked launch: one file that starts several apps. Tracked as its own task
  // (key `linked:<id>`); it never touches an app's launch state.
  handleIpc('linked:launch', async (_e, id: string) => {
    const list = await AppStore.linkedLaunches()
    const entry = list.find((item) => item.id === id)
    if (!entry) throw new Error('关联启动不存在')
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
    return launchTracked(linkedRunKey(entry.id), entry.name, spec, [basename(entry.targetPath)], null, false)
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
