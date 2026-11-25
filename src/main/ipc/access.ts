import { ipcMain } from 'electron'
import { senderRole, type WindowRole } from '../services/windowRole'
import { runWithDataAccess } from './dataAccess'
const viewerActions = new Set(['gallery:viewerNav', 'gallery:contextMenu', 'window:close'])

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
      throw new Error('此窗口无权执行该操作')
    }
    return runWithDataAccess(channel, () => handler(event, ...args))
  })
}
