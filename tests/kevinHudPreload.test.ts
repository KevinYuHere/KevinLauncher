import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  expose: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => null)
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: {
    on: electron.on,
    removeListener: electron.removeListener,
    invoke: electron.invoke
  }
}))

const config = {
  enabled: true,
  metrics: ['fps']
}

const frame = {
  phase: 'monitor' as const,
  config: config as never,
  appName: 'Test',
  iconUrl: null,
  fontFamily: null,
  appGlass: null,
  values: { fps: '60' }
}

const frameListener = (): ((_event: unknown, payload: unknown) => void) => {
  const call = electron.on.mock.calls[0]
  expect(call?.[0]).toBe('kevinHud:frame')
  return call?.[1] as (_event: unknown, payload: unknown) => void
}

describe('KEVIN HUD preload', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    electron.expose.mockClear()
    electron.on.mockClear()
    electron.removeListener.mockClear()
    electron.invoke.mockReset()
    electron.invoke.mockResolvedValue(null)
  })

  it('exposes only the narrow onFrame and ready bridge', async () => {
    await import('../src/preload/kevinHud')

    expect(electron.expose).toHaveBeenCalledTimes(1)
    expect(electron.expose).toHaveBeenCalledWith(
      'kevinHud',
      expect.objectContaining({
        onFrame: expect.any(Function),
        ready: expect.any(Function)
      })
    )
    expect(electron.on).toHaveBeenCalledWith('kevinHud:frame', expect.any(Function))
    const api = electron.expose.mock.calls[0][1] as {
      onFrame: (listener: (value: unknown) => void) => () => void
      ready: () => Promise<unknown>
    }
    expect(Object.keys(api).sort()).toEqual(['onFrame', 'ready'])
  })

  it('forwards valid pushed frames and ignores malformed envelopes', async () => {
    await import('../src/preload/kevinHud')
    const api = electron.expose.mock.calls[0][1] as {
      onFrame: (listener: (value: unknown) => void) => () => void
    }
    const seen: unknown[] = []
    const stop = api.onFrame((value) => seen.push(value))
    const handler = frameListener()

    handler({}, { nope: true })
    handler({}, { ...frame, phase: 'unknown' })
    expect(seen).toEqual([])

    handler({}, frame)
    expect(seen).toEqual([frame])
    stop()
    handler({}, { ...frame, values: { fps: '30' } })
    expect(seen).toHaveLength(1)
  })

  it('replays its cached latest frame to a late subscriber', async () => {
    await import('../src/preload/kevinHud')
    const api = electron.expose.mock.calls[0][1] as {
      onFrame: (listener: (value: unknown) => void) => () => void
    }
    const handler = frameListener()
    handler({}, frame)

    const seen: unknown[] = []
    api.onFrame((value) => seen.push(value))
    await Promise.resolve()
    expect(seen).toEqual([frame])
  })

  it('pulls the latest cached frame and forwards an opaque owner token', async () => {
    electron.invoke.mockResolvedValueOnce(frame)
    await import('../src/preload/kevinHud')
    const api = electron.expose.mock.calls[0][1] as {
      ready: (handshake?: { token?: string }) => Promise<unknown>
    }

    await expect(api.ready({ token: 'owner-token' })).resolves.toBe(frame)
    expect(electron.invoke).toHaveBeenCalledWith('kevinHud:ready', { token: 'owner-token' })

    electron.invoke.mockResolvedValueOnce({ phase: 'monitor' })
    await expect(api.ready()).resolves.toBeNull()
    expect(electron.invoke).toHaveBeenCalledWith('kevinHud:ready', null)
  })

  it('does not let a throwing renderer listener break other listeners', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await import('../src/preload/kevinHud')
    const api = electron.expose.mock.calls[0][1] as {
      onFrame: (listener: (value: unknown) => void) => () => void
    }
    const seen: unknown[] = []
    api.onFrame(() => {
      throw new Error('consumer failed')
    })
    api.onFrame((value) => seen.push(value))

    frameListener()({}, frame)
    expect(seen).toEqual([frame])
    expect(errors).toHaveBeenCalled()
  })
})
