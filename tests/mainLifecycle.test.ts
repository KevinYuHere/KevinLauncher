import { beforeAll, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { transformWithEsbuild } from 'vite'

let entry: string
beforeAll(async () => {
  const source = await fs.readFile(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  entry = (await transformWithEsbuild(source, 'index.ts', { format: 'cjs' })).code
})

async function start(mode: 'app' | 'install' | 'uninstall', ownsLock = true, packaged = false, elevated = true) {
  const listeners = new Map<string, (event?: { preventDefault: () => void }) => void>()
  const events: string[] = []
  const ensureAdministrator = vi.fn(async () => elevated)
  const app = {
    isPackaged: packaged,
    on: (name: string, handler: () => void) => listeners.set(name, handler),
    getPath: () => 'fixture-data',
    setName() {},
    requestSingleInstanceLock: vi.fn(() => ownsLock),
    quit: vi.fn()
  }
  let ready: Promise<unknown> | undefined
  const whenReady = vi.fn(() => ({ then: (handler: () => void) => {
    ready = Promise.resolve().then(handler)
  } }))
  const isolateSetupSession = vi.fn()
  let release!: () => void
  const waitingToFlush = new Promise<void>(resolve => { release = resolve })
  const flush = vi.fn(() => waitingToFlush)
  const policy = vi.fn(() => { events.push('policy') })
  const loadIcon = vi.fn(() => ({}))
  class StubWindow {
    webContents = { setWindowOpenHandler() {} }
    on() {}
    loadFile() {}
  }
  const modules: Record<string, unknown> = {
    electron: {
      app: { ...app, whenReady },
      protocol: { registerSchemesAsPrivileged() {}, handle() {} },
      BrowserWindow: StubWindow
    },
    fs: { promises: { readFile: async () => { throw new Error('missing fixture') } } },
    path: { join },
    '@electron-toolkit/utils': { electronApp: { setAppUserModelId() {} }, is: { dev: true } },
    './services/windowRole': { bindWindowRole() {} },
    './services/windowActivity': { observeWindowActivity() {} },
    './ipc': {
      registerIpc: (role: string) => events.push(role), warmUpFonts() {},
      appUpdate: { start() {}, cleanupOldVersions() {} }
    },
    './services/appStore': { AppStore: { launcherSettings: async () => ({ autoStart: 'off' }) } },
    './services/appIcon': { applyLauncherIcon() {}, launcherIconPaths: loadIcon },
    './services/behavior': { markQuitting() {}, setCloseToTray() {}, setMainWindowProvider() {}, ensureTray() {} },
    './services/autostart': { startedHidden: () => false, applyAutoStart: async () => {} },
    './services/dataDir': { applyDataDir() {} },
    './services/dataMoveJournal': { recoverDataMove: async () => {} },
    './services/themePolicy': { applyThemePolicyOnStartup: policy },
    './services/shutdown': { flushBeforeShutdown: flush },
    './services/setupTask': { isolateSetupSession, setupTaskActive: () => false },
    './services/appActivation': { recordApplicationStartup() {} },
    './services/install': { SETUP_EXIT_ARGUMENT: '--kevin-exit-for-setup' },
    './services/settingsBackup': { recoverSettingsImport: () => events.push('recover') },
    './services/housekeeping': { cleanUpdateStaging() {}, cleanArknightsStaging: async () => {} },
    './services/elevation': { isElevated: async () => elevated, ensureAdministrator },
    './services/logger': { log() {} }
  }
  runInNewContext(entry, {
    require: (name: string) => modules[name] ?? {},
    process: { env: {}, argv: mode === 'app' ? [] : [`--${mode}`], platform: 'win32' },
    __dirname: 'fixture-main', module: { exports: {} }, exports: {}
  })
  await ready
  return { listeners, events, app, flush, release, policy, loadIcon, ensureAdministrator, isolateSetupSession, whenReady }
}

describe('launcher data lifecycle', () => {
  it.each(['app', 'install', 'uninstall'] as const)('stops packaged %s before IPC and the instance lock when elevation is required', async mode => {
    const result = await start(mode, true, true, false)
    expect(result.ensureAdministrator).toHaveBeenCalledWith(mode)
    expect(result.app.quit).toHaveBeenCalledOnce()
    expect(result.app.requestSingleInstanceLock).not.toHaveBeenCalled()
    expect(result.events).toEqual([])
    expect(result.listeners.has('before-quit')).toBe(false)
  })

  it('the primary instance recovers data before loading policy and waits for disk on repeated quits', async () => {
    const main = await start('app')
    expect(main.isolateSetupSession).not.toHaveBeenCalled()
    expect(main.events).toEqual(['recover', 'app', 'policy'])
    const beforeQuit = main.listeners.get('before-quit')!
    const preventDefault = vi.fn()
    beforeQuit({ preventDefault })
    beforeQuit({ preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(2)
    expect(main.flush).toHaveBeenCalledOnce()
    expect(main.app.quit).not.toHaveBeenCalled()
    main.release()
    await Promise.resolve()
    expect(main.app.quit).toHaveBeenCalledOnce()
    beforeQuit({ preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(2)
  })

  it('does not initialize data or attach exit writes for a second launcher instance', async () => {
    const second = await start('app', false)
    expect(second.app.quit).toHaveBeenCalledOnce()
    expect(second.events).toEqual([])
    expect(second.listeners.has('before-quit')).toBe(false)
  })

  it.each(['install', 'uninstall'] as const)('opening %s mode skips settings and release policy', async (mode) => {
    const setup = await start(mode)
    expect(setup.isolateSetupSession).toHaveBeenCalledOnce()
    expect(setup.isolateSetupSession.mock.invocationCallOrder[0]).toBeLessThan(setup.whenReady.mock.invocationCallOrder[0])
    expect(setup.events).toEqual([mode])
    expect(setup.policy).not.toHaveBeenCalled()
    expect(setup.loadIcon).not.toHaveBeenCalled()
  })
})
