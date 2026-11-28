import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MATERIAL_DEFAULTS, type AppEntry, type GlassAppearance } from '@shared/types'
import { SPECIAL_AREAS } from '@shared/specialTheme'
import type { ThemeAssignments, ThemeLocks } from '@shared/specialTheme'
import {
  APPEARANCE_PRESET_FILE,
  APPEARANCE_PRESET_NAME_MAX,
  applyAppearancePreset,
  appearancePresetNameError,
  normalizeAppearancePresetFile,
  type AppearancePreset,
  type AppearancePresetTarget
} from '@shared/appearancePreset'
import { createAppearancePresetStore } from '../src/main/services/appearancePresetStore'
import { registerAppearancePresetsIpc } from '../src/main/ipc/appearancePresets'

const ipc = vi.hoisted(() => ({
  handleIpc: vi.fn((_channel: string, _handler: unknown) => {})
}))

vi.mock('../src/main/ipc/access', () => ({ handleIpc: ipc.handleIpc }))
vi.mock('../src/main/services/appStore', () => ({ AppStore: {} }))
vi.mock('../src/main/services/appearancePresets', () => ({ appearancePresets: {} }))
vi.mock('../src/main/services/logger', () => ({ log: vi.fn() }))
vi.mock('../src/main/ipc/context', () => ({
  broadcast: vi.fn(),
  notifyAppsChanged: vi.fn()
}))

const ISO = '2026-11-26T08:00:00.000Z'
const EARLIER = '2026-11-25T08:00:00.000Z'
const dirs: string[] = []

const glass = (overrides: Partial<GlassAppearance> = {}): GlassAppearance => ({
  ...MATERIAL_DEFAULTS.liquid,
  brightness: 34,
  opacity: 71,
  saturation: 141,
  edgeWidth: 57,
  ...overrides
})

function app(id: string, overrides: Partial<AppEntry> = {}): AppEntry {
  return {
    id,
    name: `Game ${id}`,
    moduleLabel: null,
    launchMethods: [
      {
        id: `method-${id}`,
        name: '默认',
        targetPath: `D:/Games/${id}/Game.exe`,
        arguments: '--windowed',
        workingDirectory: `D:/Games/${id}`,
        runAsAdmin: true
      }
    ],
    defaultLaunchMethodId: `method-${id}`,
    gameDirectory: `D:/Games/${id}`,
    environmentVariables: { KEEP_ME: '1' },
    addonId: 'genshin',
    iconFile: null,
    wallpapers: [{ id: `wall-${id}`, file: 'wall.png', name: 'wall.png' }],
    wallpaperSettings: { strategy: 'loop', trigger: 'appSwitch', intervalMinutes: 30 },
    wallpaperIndex: 0,
    themeColor: '#123456',
    glass: glass(),
    autoTheme: false,
    backgroundBlur: 12,
    backgroundDim: 63,
    screenshotDirectory: null,
    monitorProcessNames: ['Game.exe'],
    gachaShowSecond: true,
    linkedLaunchIds: ['linked-1'],
    defaultLinkedLaunchId: null,
    launchEffect: 'nova',
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides
  }
}

function areaMap(
  overrides: Partial<Record<string, string>> = {}
): AppearancePreset['areas'] {
  return Object.fromEntries(
    SPECIAL_AREAS.map((area) => [area.id, overrides[area.id] ?? 'default'])
  ) as AppearancePreset['areas']
}

/** Canonical version 1 fixture, independent of any capture path. */
function preset(overrides: Partial<AppearancePreset> = {}): AppearancePreset {
  return {
    id: 'preset-1',
    name: '夜航',
    createdAt: ISO,
    updatedAt: ISO,
    areas: areaMap({ titlebar: 'starsnow', cards: 'mitia', sidebar: 'starsnow' }),
    apps: {
      a: {
        themeColor: '#123456',
        autoTheme: false,
        glass: glass(),
        launchEffect: 'nova',
        backgroundDim: 63
      },
      b: {
        themeColor: null,
        autoTheme: true,
        glass: glass({ material: 'blur' }),
        launchEffect: 'none',
        backgroundDim: 40
      }
    },
    ...overrides
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('appearance preset snapshots', () => {
  it('loads the canonical version 1 format and restores only appearance fields', () => {
    const normalized = normalizeAppearancePresetFile({ version: 1, presets: [preset()] })
    expect(normalized?.invalid).toBe(0)
    const saved = normalized!.presets[0]
    expect(Object.keys(saved.areas)).toHaveLength(28)
    expect(saved.areas.titlebar).toBe('starsnow')
    expect(saved.areas.cards).toBe('mitia')

    const config = {
      apps: [app('a'), app('b', { themeColor: '#abcdef', glass: glass({ material: 'shine' }) })],
      linkedLaunches: [{ id: 'linked-1', name: 'Keep me' }],
      launcher: {
        iconFile: 'brand.png',
        themeAreas: {
          titlebar: 'starsnow',
          cards: 'mitia',
          sidebar: 'starsnow',
          toast: 'default'
        } as ThemeAssignments,
        themeLocks: { cards: 'starsnow' } as ThemeLocks,
        themePolicyVersion: '2.0.5'
      }
    }

    const beforeMethods = structuredClone(config.apps[0].launchMethods)
    const beforeWallpapers = structuredClone(config.apps[0].wallpapers)

    config.apps[0].themeColor = '#000000'
    config.apps[0].autoTheme = true
    config.apps[0].glass = { ...MATERIAL_DEFAULTS.blur }
    config.apps[0].launchEffect = 'none'
    config.apps[0].backgroundDim = 0
    config.apps.push(app('c', { themeColor: '#ff0000' }))
    config.launcher.themeAreas = { titlebar: 'mitia', cards: 'default' }
    config.launcher.themeLocks = { titlebar: 'mitia' }

    const applied = applyAppearancePreset(
      config as unknown as AppearancePresetTarget,
      saved,
      ISO
    )

    expect(applied).toEqual({ apps: 2, areas: 3 })
    expect(config.apps).toHaveLength(3)
    expect(config.apps.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
    expect(config.apps[0]).toMatchObject({
      themeColor: '#123456',
      autoTheme: false,
      launchEffect: 'nova',
      backgroundDim: 63,
      backgroundBlur: 12,
      updatedAt: ISO
    })
    expect(config.apps[0].glass).toEqual(glass())
    expect(config.apps[1]).toMatchObject({ themeColor: null, autoTheme: true, launchEffect: 'none' })
    expect(config.apps[2].themeColor).toBe('#ff0000')
    expect(config.apps[0].launchMethods).toEqual(beforeMethods)
    expect(config.apps[0].wallpapers).toEqual(beforeWallpapers)
    expect(config.apps[0].linkedLaunchIds).toEqual(['linked-1'])
    expect(config.linkedLaunches).toEqual([{ id: 'linked-1', name: 'Keep me' }])
    expect(config.launcher.iconFile).toBe('brand.png')
    expect(config.launcher.themePolicyVersion).toBe('2.0.5')
    expect(config.launcher.themeLocks).toEqual({})
    expect(config.launcher.themeAreas).toEqual({
      titlebar: 'starsnow',
      cards: 'mitia',
      sidebar: 'starsnow'
    })
  })

  it('keeps the persisted name and file validation rules', () => {
    expect(appearancePresetNameError('')).toBeTruthy()
    expect(appearancePresetNameError('   ')).toBeTruthy()
    expect(appearancePresetNameError('x'.repeat(APPEARANCE_PRESET_NAME_MAX + 1))).toBeTruthy()
    expect(appearancePresetNameError('bad\u0007name')).toBeTruthy()
    expect(appearancePresetNameError(' 夜航 ')).toBeNull()

    expect(
      normalizeAppearancePresetFile({
        version: 1,
        presets: [{ ...preset(), apps: { a: { ...preset().apps.a, backgroundDim: 101 } } }]
      })
    ).toEqual({ presets: [], invalid: 1 })
    expect(normalizeAppearancePresetFile({ version: 2, presets: [] })).toBeNull()
    expect(
      normalizeAppearancePresetFile({ version: 1, presets: [preset({ name: 'bad\u0007name' })] })
    ).toEqual({ presets: [], invalid: 1 })
  })
})

describe('appearance preset store', () => {
  it('lists, loads and removes canonical presets while preserving the version 1 format', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'kl-preset-store-'))
    dirs.push(root)
    const file = join(root, APPEARANCE_PRESET_FILE)
    const canonical = JSON.stringify(
      {
        version: 1,
        presets: [
          preset(),
          preset({
            id: 'preset-2',
            name: '晨光',
            createdAt: EARLIER,
            updatedAt: EARLIER,
            areas: areaMap({ titlebar: 'default' })
          })
        ]
      },
      null,
      2
    )
    await fs.writeFile(file, canonical)
    const store = createAppearancePresetStore(() => root)

    const listed = await store.list()
    expect(listed).toHaveLength(2)
    expect(listed.find((item) => item.id === 'preset-1')).toMatchObject({
      name: '夜航',
      appCount: 2,
      themedAreaCount: 3
    })
    expect(listed.find((item) => item.id === 'preset-2')).toMatchObject({ name: '晨光' })
    expect(await fs.readFile(file, 'utf8')).toBe(canonical)

    expect(await store.get('preset-2')).toMatchObject({ name: '晨光', areas: { titlebar: 'default' } })
    expect(await store.get('missing')).toBeNull()
    expect(await fs.readFile(file, 'utf8')).toBe(canonical)

    const remaining = await store.remove('preset-1')
    expect(remaining.map((item) => item.name)).toEqual(['晨光'])
    const next = JSON.parse(await fs.readFile(file, 'utf8')) as {
      version: number
      presets: AppearancePreset[]
    }
    expect(next.version).toBe(1)
    expect(next.presets.map((item) => item.id)).toEqual(['preset-2'])
    await expect(store.remove('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('keeps the previous file when a removal write fails and refuses to rewrite a damaged store', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'kl-preset-atomic-'))
    dirs.push(root)
    const file = join(root, APPEARANCE_PRESET_FILE)
    const canonical = JSON.stringify({ version: 1, presets: [preset()] }, null, 2)
    await fs.writeFile(file, canonical)
    const store = createAppearancePresetStore(() => root)

    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation((source, target) =>
      target === file ? Promise.reject(new Error('disk full')) : rename(source, target)
    )
    await expect(store.remove('preset-1')).rejects.toMatchObject({ code: 'SAVE_FAILED' })
    expect(await fs.readFile(file, 'utf8')).toBe(canonical)

    vi.restoreAllMocks()
    const damaged = JSON.stringify({ version: 1, presets: [{ bad: true }] })
    await fs.writeFile(file, damaged)
    expect(await store.list()).toEqual([])
    await expect(store.remove('preset-1')).rejects.toMatchObject({ code: 'READ_FAILED' })
    expect(await fs.readFile(file, 'utf8')).toBe(damaged)
  })
})

describe('appearance preset IPC', () => {
  it('registers only the list, apply and remove channels', () => {
    ipc.handleIpc.mockClear()
    ipc.handleIpc.mockImplementation((_channel: string, _handler: unknown) => {})
    registerAppearancePresetsIpc()

    expect(ipc.handleIpc.mock.calls.map(([channel]) => channel)).toEqual([
      'appearancePresets:list',
      'appearancePresets:apply',
      'appearancePresets:remove'
    ])
  })
})
