import { handleIpc } from './access'
import { basename } from 'path'
import { defaultLaunchMethod, launchMethodById } from '@shared/appEntry'
import { AppStore } from '../services/appStore'
import { Launcher, type LaunchSpec } from '../services/launcher'
import { playTime, runtime } from './context'

/** Runtime key for a linked-launch task (kept distinct from app ids). */
export const linkedRunKey = (id: string): string => `linked:${id}`

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

    const spec: LaunchSpec = {
      targetPath: method.targetPath,
      arguments: method.arguments,
      workingDirectory: method.workingDirectory,
      runAsAdmin: method.runAsAdmin,
      environmentVariables: entry.environmentVariables
    }
    const result = await Launcher.launch(spec, entry.name)
    if (result.ok) {
      // Elevated launches (when the launcher itself is not elevated) cannot be
      // tracked by pid; fall back to monitoring the target's own process name.
      const monitor = [...entry.monitorProcessNames]
      if (result.elevated && result.pid === null && monitor.length === 0) {
        monitor.push(basename(method.targetPath))
      }
      runtime.start(entry.id, result.pid, result.elevated, monitor)
    }
    return result
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
    const result = await Launcher.launch(spec, entry.name)
    if (result.ok) {
      // Tracked live (running state / stop) but never counted as play time:
      // a linked launch is not one of the launcher's apps.
      runtime.start(
        linkedRunKey(entry.id),
        result.pid,
        result.elevated,
        [basename(entry.targetPath)],
        false
      )
    }
    return result
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
