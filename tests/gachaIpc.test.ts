import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerGachaIpc } from '../src/main/ipc/gacha'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  load: vi.fn(),
  scan: vi.fn(),
  add: vi.fn(),
  addWithSync: vi.fn(),
  checkpoints: vi.fn(),
  clear: vi.fn(),
  count: vi.fn(),
  page: vi.fn(),
  exportArchive: vi.fn(),
  sync: vi.fn()
}))
vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, dialog: {} }))
vi.mock('../src/main/ipc/access', () => ({
  handleIpc: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler)
}))
vi.mock('../src/main/ipc/context', () => ({
  broadcast: vi.fn(),
  gacha: {
    clear: mocks.clear, add: mocks.add, addWithSync: mocks.addWithSync, checkpoints: mocks.checkpoints,
    count: mocks.count, page: mocks.page, exportArchive: mocks.exportArchive
  }
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
vi.mock('../src/main/gacha/mihoyo', () => ({ syncMiHoYoGacha: mocks.sync }))

const fixture = {
  id: 'fixture', name: 'fixture', addonId: 'genshin', gameDirectory: null,
  launchMethods: [{ id: 'method', targetPath: 'relative.exe' }], defaultLaunchMethodId: 'method'
}
const call = async (route: string, ...args: unknown[]) => mocks.handlers.get(route)!(null, ...args)
const result = (overrides: Record<string, unknown> = {}) => ({
  records: [], checkpoints: [], mode: 'incremental', pages: 1, earlyStopped: false, ...overrides
})

beforeEach(() => {
  vi.resetAllMocks()
  mocks.handlers.clear()
  mocks.load.mockResolvedValue({ apps: [fixture] })
  mocks.checkpoints.mockResolvedValue([])
  mocks.addWithSync.mockResolvedValue(0)
  mocks.add.mockResolvedValue(0)
  mocks.count.mockResolvedValue(0)
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
    mocks.sync.mockResolvedValue(result())
    await expect(call('gacha:updateMiHoYo', fixture.id, 'fixture')).rejects.toThrow('已变更')
    expect(mocks.addWithSync).not.toHaveBeenCalled()
  })

  it('persists records and confirmed boundaries together in incremental mode by default', async () => {
    const checkpoint = {
      game: 'genshin', uid: '100000001', pool: '301', boundaryId: '900',
      completedAt: 1, pages: 2
    }
    mocks.checkpoints.mockResolvedValue([checkpoint])
    mocks.sync.mockResolvedValue(result({
      records: [{ id: 'genshin:100000001:901' }], checkpoints: [{ ...checkpoint, boundaryId: '901' }],
      pages: 2, earlyStopped: true
    }))
    mocks.addWithSync.mockResolvedValue(1)
    mocks.count.mockResolvedValue(7)

    const answer = await call('gacha:updateMiHoYo', fixture.id, 'fixture', undefined) as {
      added: number; total: number; message: string
    }
    expect(mocks.sync).toHaveBeenCalledWith('genshin', 'fixture', fixture.id,
      expect.objectContaining({ mode: 'incremental', checkpoints: [checkpoint] }))
    expect(mocks.addWithSync).toHaveBeenCalledWith(fixture.id,
      [{ id: 'genshin:100000001:901' }], [expect.objectContaining({ boundaryId: '901' })])
    expect(answer).toMatchObject({ added: 1, total: 7 })
    expect(answer.message).toContain('已到可信边界')
  })

  it('uses a full traversal on request without reading incremental checkpoints', async () => {
    mocks.sync.mockResolvedValue(result({ mode: 'full', pages: 4 }))
    await call('gacha:updateMiHoYo', fixture.id, 'fixture', 'full')
    expect(mocks.checkpoints).not.toHaveBeenCalled()
    expect(mocks.sync).toHaveBeenCalledWith('genshin', 'fixture', fixture.id,
      expect.objectContaining({ mode: 'full', checkpoints: [] }))
  })

  it('does not persist records or move a checkpoint when the fetch fails', async () => {
    mocks.sync.mockRejectedValue(new Error('抽卡接口请求过快，请稍后重试'))
    await expect(call('gacha:updateMiHoYo', fixture.id, 'fixture')).rejects.toThrow('请求过快')
    expect(mocks.addWithSync).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled()
  })

  it('rejects an unknown sync mode before making a request', async () => {
    await expect(call('gacha:updateMiHoYo', fixture.id, 'fixture', 'everything')).rejects.toThrow('同步方式')
    expect(mocks.sync).not.toHaveBeenCalled()
  })
})
