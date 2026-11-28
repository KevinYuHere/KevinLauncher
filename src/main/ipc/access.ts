import { ipcMain } from 'electron'
import { senderRole, type WindowRole } from '../services/windowRole'
import { runWithDataAccess } from './dataAccess'
import { trialBuild } from '../services/buildIdentity'
const viewerActions = new Set(['gallery:viewerNav', 'gallery:contextMenu', 'window:close'])
const trialBlocked = new Set(['apps:launch', 'linked:launch', 'runtime:stop', 'shell:openPath', 'gacha:scanUrl'])

export function allowsChannel(role: WindowRole, channel: string): boolean {
  if (role === 'viewer') return viewerActions.has(channel)
  if (role === 'install') return channel.startsWith('installer:') || channel === 'dataDir:pick' || channel === 'window:close'
  if (role === 'uninstall') return channel.startsWith('uninstaller:') || channel === 'window:close'
  return !channel.startsWith('installer:') && !channel.startsWith('uninstaller:') && channel !== 'gallery:viewerNav'
}

export function handleIpc(channel: string, handler: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, (event, ...args) => {
    const role = senderRole(event)
    if (!role || !allowsChannel(role, channel)) {
      throw new Error('当前窗口不能执行这个操作')
    }
    if (trialBuild && trialBlocked.has(channel)) throw new Error('本地试用版不能操作其他文件或程序')
    return runWithDataAccess(channel, () => handler(event, ...args))
  })
}
