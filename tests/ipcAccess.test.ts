import { describe, expect, it, vi } from 'vitest'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
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

  it.skipIf(process.platform !== 'win32')('authorizes the known Windows renderer file across trusted pathname spellings only', () => {
    const original = 'C:\\Users\\RUNNER~1\\Trial Temp\\renderer\\index.html'
    const canonical = 'C:\\Users\\runneradmin\\Trial Temp\\renderer\\index.html'
    const realpath = vi.spyOn(realpathSync, 'native').mockReturnValue(canonical)
    try {
      const frame = { url: '' }
      const sender = { on: vi.fn(), mainFrame: frame }
      const run = vi.fn()
      handleIpc('installer:info', run)
      const url = bindWindowRole(sender as never, 'install', pathToFileURL(original).href)
      const invoke = (senderFrame = frame) => registered.get('installer:info')({ sender, senderFrame })
      expect(url.href).toBe(pathToFileURL(canonical).href)
      expect(realpath).toHaveBeenCalledWith(original)
      for (const file of [url.href, 'file:///c:/Users/RUNNER~1/Trial%20Temp/rend%65rer/index.html']) {
        frame.url = file + '#install'
        invoke()
        expect(() => invoke({ ...frame })).toThrow()
      }
      const onNavigate = sender.on.mock.calls[0][1]
      for (const file of ['file:///C:/Other/index.html', 'file://server/Trial%20Temp/renderer/index.html',
        'https://localhost/index.html', 'file:///C:/Users/RUNNER~1/Trial%20Temp/renderer%2findex.html',
        url.href + '?mode=install', url.href + '?', 'invalid url']) {
        frame.url = file
        expect(() => invoke()).toThrow()
        const preventDefault = vi.fn()
        onNavigate({ preventDefault }, file)
        expect(preventDefault).toHaveBeenCalledOnce()
      }
      expect(run).toHaveBeenCalledTimes(2)
      expect(realpath).toHaveBeenCalledOnce()
    } finally {
      realpath.mockRestore()
    }
  })
})
