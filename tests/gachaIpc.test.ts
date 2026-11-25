import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerGachaIpc } from '../src/main/ipc/gacha'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  load: vi.fn(),
  scan: vi.fn(),
  add: vi.fn(),
  clear: vi.fn(),
  page: vi.fn(),
  exportArchive: vi.fn(),
  fetch: vi.fn()
}))
vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, dialog: {} }))
vi.mock('../src/main/ipc/access', () => ({
  handleIpc: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler)
}))
vi.mock('../src/main/ipc/context', () => ({
  broadcast: vi.fn(),
  gacha: { clear: mocks.clear, add: mocks.add, page: mocks.page, exportArchive: mocks.exportArchive }
}))
vi.mock('../src/main/services/appStore', () => ({
  AppStore: { load: mocks.load },
  requireApp: (config: { apps: { id: string }[] }, id: string) => {
    const entry = config.apps.find((entry) => entry.id === id)
    if (!entry) throw new Error('应用不存在')
    return entry
  }
}))
vi.mock('../src/main/gacha/gachaFiles', () => ({ readGachaArchive: vi.fn() }))
vi.mock('../src/main/gacha/urlSource', () => ({ scanWebCache: mocks.scan }))
vi.mock('../src/main/gacha/mihoyo', () => ({ fetchMiHoYoGacha: mocks.fetch }))

const fixture = {
  id: 'fixture', name: 'fixture', addonId: 'genshin', gameDirectory: null,
  launchMethods: [{ id: 'method', targetPath: 'relative.exe' }], defaultLaunchMethodId: 'method'
}
const call = async (route: string, ...args: unknown[]) => mocks.handlers.get(route)!(null, ...args)

beforeEach(() => {
  vi.resetAllMocks()
  mocks.handlers.clear()
  mocks.load.mockResolvedValue({ apps: [fixture] })
  registerGachaIpc()
})

describe('gacha IPC admission', () => {
  it('does not scan the launcher directory when the app has no absolute game path', async () => {
    await expect(call('gacha:scanUrl', fixture.id)).resolves.toBeNull()
    expect(mocks.scan).not.toHaveBeenCalled()
  })

  it('keeps a removed app’s retained history out of public clear, export and page operations', async () => {
    for (const route of ['gacha:clear', 'gacha:export', 'gacha:page']) {
      await expect(call(route, 'removed')).rejects.toThrow('应用不存在')
    }
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(mocks.exportArchive).not.toHaveBeenCalled()
    expect(mocks.page).not.toHaveBeenCalled()
  })

  it('rejects history from a fetch whose associated game changed before persistence', async () => {
    mocks.load.mockResolvedValueOnce({ apps: [fixture] })
      .mockResolvedValueOnce({ apps: [{ ...fixture, addonId: 'starrail' }] })
    mocks.fetch.mockResolvedValue([])
    await expect(call('gacha:updateMiHoYo', fixture.id, 'fixture')).rejects.toThrow('已变更')
    expect(mocks.add).not.toHaveBeenCalled()
  })
})
