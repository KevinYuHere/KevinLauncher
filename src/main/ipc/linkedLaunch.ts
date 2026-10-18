import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import type { LinkedLaunch } from '@shared/types'
import { AppStore } from '../services/appStore'
import { log } from '../services/logger'
import { notifyAppsChanged } from './context'

/** Launcher-wide "linked launches": one file that starts several apps. */
export function registerLinkedLaunchIpc(): void {
  ipcMain.handle('linked:list', () => AppStore.linkedLaunches())

  ipcMain.handle(
    'linked:add',
    async (_e, input: Omit<LinkedLaunch, 'id'> & { id?: string; showInGamesRow?: boolean }) => {
      const list = await AppStore.linkedLaunches()
      const entry: LinkedLaunch = {
        id: randomUUID(),
        name: input.name?.trim() || '未命名关联启动',
        targetPath: input.targetPath ?? '',
        arguments: input.arguments ?? '',
        workingDirectory: input.workingDirectory ?? '',
        runAsAdmin: input.runAsAdmin ?? true,
        showInGamesRow: input.showInGamesRow ?? true
      }
      list.push(entry)
      await AppStore.setLinkedLaunches(list)
      log(`linked: added "${entry.name}" (${entry.targetPath})`)
      notifyAppsChanged()
      return entry
    }
  )

  ipcMain.handle('linked:update', async (_e, input: LinkedLaunch) => {
    const list = await AppStore.linkedLaunches()
    const index = list.findIndex((item) => item.id === input.id)
    if (index < 0) throw new Error('关联启动不存在')
    list[index] = {
      ...list[index],
      name: input.name?.trim() || list[index].name,
      targetPath: input.targetPath ?? '',
      arguments: input.arguments ?? '',
      workingDirectory: input.workingDirectory ?? '',
      runAsAdmin: !!input.runAsAdmin,
      showInGamesRow: input.showInGamesRow ?? true
    }
    await AppStore.setLinkedLaunches(list)
    notifyAppsChanged()
    return list[index]
  })

  ipcMain.handle('linked:remove', async (_e, id: string) => {
    const list = await AppStore.linkedLaunches()
    await AppStore.setLinkedLaunches(list.filter((item) => item.id !== id))
    // Drop the association from every app and fix the defaults it may hold.
    const store = await AppStore.load()
    for (const app of store.apps) {
      app.linkedLaunchIds = (app.linkedLaunchIds ?? []).filter((x) => x !== id)
      if (app.defaultLinkedLaunchId === id) {
        app.defaultLinkedLaunchId = app.linkedLaunchIds[0] ?? null
      }
    }
    await AppStore.save()
    notifyAppsChanged()
  })

  ipcMain.handle('linked:reorder', async (_e, ids: string[]) => {
    const list = await AppStore.reorderLinkedLaunches(ids)
    notifyAppsChanged()
    return list
  })

  ipcMain.handle(
    'linked:setApp',
    async (_e, appId: string, ids: string[], defaultId: string | null) => {
      const store = await AppStore.load()
      const app = store.apps.find((a) => a.id === appId)
      if (!app) throw new Error('应用不存在')
      const known = new Set((await AppStore.linkedLaunches()).map((item) => item.id))
      const ordered: string[] = []
      for (const id of ids) if (known.has(id) && !ordered.includes(id)) ordered.push(id)
      app.linkedLaunchIds = ordered
      app.defaultLinkedLaunchId =
        defaultId && ordered.includes(defaultId) ? defaultId : (ordered[0] ?? null)
      app.updatedAt = new Date().toISOString()
      await AppStore.save()
      notifyAppsChanged()
      return app
    }
  )
}
