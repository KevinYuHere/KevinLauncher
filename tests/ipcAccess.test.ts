import { describe, expect, it, vi } from 'vitest'
const registered = vi.hoisted(() => new Map())
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: unknown) => registered.set(channel, fn) } }))
vi.mock('../src/main/ipc/dataAccess', () => ({ runWithDataAccess: (_: string, action: () => unknown) => action() }))
import { allowsChannel, handleIpc } from '../src/main/ipc/access'
import { bindWindowRole } from '../src/main/services/windowRole'

describe('IPC window ownership', () => {
  it('keeps setup and viewer operations within the window role', () => {
    expect(allowsChannel('install', 'dataDir:pick')).toBe(true)
    expect(allowsChannel('viewer', 'gallery:viewerNav')).toBe(true)
    for (const role of ['app', 'viewer', 'uninstall'] as const) {
      expect(allowsChannel(role, 'installer:run')).toBe(false)
    }
    expect(allowsChannel('install', 'uninstaller:run')).toBe(false)
    expect(allowsChannel('uninstall', 'uninstaller:run')).toBe(true)
    expect(allowsChannel('viewer', 'data:import')).toBe(false)
  })

  it('denies other documents and subframes before the service is called', () => {
    const url = 'http://localhost:5173/'
    const frame = { url: url + '#install' }
    const sender = { on: vi.fn(), mainFrame: frame }
    const run = vi.fn()
    handleIpc('installer:run', run)
    const invoke = (senderFrame = frame) => registered.get('installer:run')({ sender, senderFrame })
    expect(() => invoke()).toThrow()
    bindWindowRole(sender as never, 'app', url)
    expect(() => invoke()).toThrow()
    bindWindowRole(sender as never, 'install', url)
    expect(() => invoke({ ...frame })).toThrow()
    frame.url = 'http://localhost:5173/other'
    expect(() => invoke()).toThrow()
    expect(run).not.toHaveBeenCalled()
    frame.url = url + '#install'
    invoke()
    expect(run).toHaveBeenCalledOnce()
  })
})
