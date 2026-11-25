import { handleIpc } from './access'
import { randomUUID } from 'crypto'
import type { LinkedLaunch } from '@shared/types'
import { AppStore, requireApp } from '../services/appStore'
import { log } from '../services/logger'
import { notifyAppsChanged } from './context'

/** Launcher-wide "linked launches": one file that starts several apps. */
export function registerLinkedLaunchIpc(): void {
  handleIpc('linked:list', () => AppStore.linkedLaunches())

  handleIpc(
    'linked:add',
    async (_e, input: Omit<LinkedLaunch, 'id'> & { id?: string; showInGamesRow?: boolean }) => {
      const entry: LinkedLaunch = {
        id: randomUUID(),
        name: input.name?.trim() || '未命名关联启动',
        targetPath: input.targetPath ?? '',
        arguments: input.arguments ?? '',
        workingDirectory: input.workingDirectory ?? '',
        runAsAdmin: input.runAsAdmin ?? true,
        showInGamesRow: input.showInGamesRow ?? true
      }
      await AppStore.mutate((config) => { (config.linkedLaunches ??= []).push(entry) })
      log(`linked: added "${entry.name}" (${entry.targetPath})`)
      notifyAppsChanged()
      return entry
    }
  )

  handleIpc('linked:update', async (_e, input: LinkedLaunch) => {
    const entry = await AppStore.mutate((config) => {
      const current = config.linkedLaunches?.find((item) => item.id === input.id)
      if (!current) throw new Error('关联启动不存在')
      Object.assign(current, {
        name: input.name?.trim() || current.name,
        targetPath: input.targetPath ?? '',
        arguments: input.arguments ?? '',
        workingDirectory: input.workingDirectory ?? '',
        runAsAdmin: input.runAsAdmin ?? true,
        showInGamesRow: input.showInGamesRow ?? true
      })
      return current
    })
    notifyAppsChanged()
    return entry
  })

  handleIpc('linked:remove', async (_e, id: string) => {
    await AppStore.mutate((store) => {
      store.linkedLaunches = (store.linkedLaunches ?? []).filter((item) => item.id !== id)
      for (const app of store.apps) {
        app.linkedLaunchIds = app.linkedLaunchIds.filter((key) => key !== id)
        if (app.defaultLinkedLaunchId === id) app.defaultLinkedLaunchId = app.linkedLaunchIds[0] ?? null
      }
    })
    notifyAppsChanged()
  })

  handleIpc('linked:reorder', async (_e, ids: string[]) => {
    const list = await AppStore.reorderLinkedLaunches(ids)
    notifyAppsChanged()
    return list
  })

  handleIpc(
    'linked:setApp',
    async (_e, appId: string, ids: string[], defaultId: string | null) => {
      const app = await AppStore.mutate((store) => {
        const entry = requireApp(store, appId)
        const known = new Set((store.linkedLaunches ?? []).map((item) => item.id))
        const ordered = [...new Set(ids.filter((id) => known.has(id)))]
        entry.linkedLaunchIds = ordered
        entry.defaultLinkedLaunchId =
          defaultId && ordered.includes(defaultId) ? defaultId : (ordered[0] ?? null)
        entry.updatedAt = new Date().toISOString()
        return entry
      })
      notifyAppsChanged()
      return app
    }
  )
}
