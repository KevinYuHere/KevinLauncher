import { describe, expect, it } from 'vitest'
import type { AppEntry } from '@shared/types'
import { CURRENT_VERSION, migrateConfig, type MigratableConfig } from '../src/main/services/appMigrations'

/** A pre-v13 app: a single launch target and a single background. */
function legacyApp(overrides: Record<string, unknown> = {}): AppEntry {
  return {
    id: 'a1',
    name: '示例',
    moduleLabel: null,
    targetPath: 'C:\\game\\game.exe',
    arguments: '--foo bar',
    workingDirectory: 'C:\\game',
    gameDirectory: null,
    environmentVariables: {},
    runAsAdmin: true,
    addonId: null,
    iconFile: null,
    backgroundFile: 'bg-1.png',
    themeColor: '#123456',
    glass: undefined as unknown as AppEntry['glass'],
    autoTheme: false,
    backgroundBlur: 5,
    backgroundDim: 40,
    screenshotDirectory: null,
    monitorProcessNames: [],
    gachaShowSecond: true,
    launchEffect: 'none',
    createdAt: '',
    updatedAt: '',
    ...overrides
  } as unknown as AppEntry
}

describe('migrateConfig', () => {
  it('turns a single target into one default launch method', () => {
    const config = { version: 12, apps: [legacyApp()], linkedLaunches: [] } as MigratableConfig
    migrateConfig(config)
    const app = config.apps[0]
    expect(app.launchMethods).toHaveLength(1)
    expect(app.launchMethods[0].targetPath).toBe('C:\\game\\game.exe')
    expect(app.launchMethods[0].arguments).toBe('--foo bar')
    expect(app.launchMethods[0].workingDirectory).toBe('C:\\game')
    expect(app.defaultLaunchMethodId).toBe(app.launchMethods[0].id)
    expect((app as unknown as { targetPath?: string }).targetPath).toBeUndefined()
  })

  it('turns a single background into a one-item wallpaper list', () => {
    const config = { version: 12, apps: [legacyApp()], linkedLaunches: [] } as MigratableConfig
    migrateConfig(config)
    const app = config.apps[0]
    expect(app.wallpapers).toHaveLength(1)
    expect(app.wallpapers[0].file).toBe('bg-1.png')
    expect(app.wallpaperIndex).toBe(0)
    expect(app.wallpaperSettings.strategy).toBe('loop')
    expect(app.linkedLaunchIds).toEqual([])
    expect(app.defaultLinkedLaunchId).toBeNull()
  })

  it('upgrades from v1 and reaches the current version', () => {
    const app = legacyApp({ glass: undefined, autoTheme: undefined })
    const config = {
      version: 1,
      apps: [app],
      launcher: {}
    } as unknown as MigratableConfig
    const changed = migrateConfig(config)
    expect(changed).toBe(true)
    expect(config.version).toBe(CURRENT_VERSION)
    expect(config.apps[0].launchMethods).toHaveLength(1)
    expect(config.apps[0].wallpapers).toHaveLength(1)
    expect(config.linkedLaunches).toEqual([])
  })

  it('is a no-op on an up-to-date config', () => {
    const config = { version: CURRENT_VERSION, apps: [], linkedLaunches: [] } as MigratableConfig
    expect(migrateConfig(config)).toBe(false)
  })
})
