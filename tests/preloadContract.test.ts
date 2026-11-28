import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(async () => null)
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: { invoke: electron.invoke }
}))

beforeEach(() => {
  vi.resetModules()
  electron.expose.mockClear()
  electron.invoke.mockClear()
})

describe('preload bridge', () => {
  it('exposes the remaining appearance preset methods without save IPC', async () => {
    await import('../src/preload/index')

    expect(electron.expose).toHaveBeenCalledTimes(1)
    const [key, api] = electron.expose.mock.calls[0] as [
      string,
      Record<string, (...args: unknown[]) => unknown>
    ]
    expect(key).toBe('api')

    const calls: Array<[string, string, unknown[]]> = [
      ['appearancePresetsList', 'appearancePresets:list', []],
      ['appearancePresetsApply', 'appearancePresets:apply', ['preset-1']],
      ['appearancePresetsRemove', 'appearancePresets:remove', ['preset-1']],
      ['gameDiscoveryScan', 'gameDiscovery:scan', []],
      [
        'kevinHudUpdateLive',
        'kevinHud:updateLive',
        ['app-1', { enabled: true, metrics: ['fps'] }]
      ]
    ]
    for (const [method, channel, args] of calls) {
      expect(api[method]).toBeTypeOf('function')
      await api[method](...args)
      expect(electron.invoke).toHaveBeenLastCalledWith(channel, ...args)
    }

    expect(api.appearancePresetsSave).toBeUndefined()

    expect(api.setGachaShowSecond).toBeTypeOf('function')
    expect(api.consumeUpgradeFeatures).toBeTypeOf('function')
    expect(api.completeUpgradeIntro).toBeTypeOf('function')
  })
})
