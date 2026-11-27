import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AppStore } from '../src/main/services/appStore'
import { recordUpgradeSource } from '../src/main/services/appActivation'
import { applyUpgradeFeaturesOnReady, completeUpgradeIntro } from '../src/main/services/themePolicy'
import { TokenStore } from '../src/main/services/tokenStore'

const test = vi.hoisted(() => ({ data: '', resources: '', version: '2.0.5', encryption: true }))
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => test.data, getVersion: () => test.version },
  safeStorage: {
    isEncryptionAvailable: () => test.encryption,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))
vi.mock('../src/main/services/appVersion', () => ({ currentAppVersion: () => test.version }))

let root: string
const app = { id: 'app', name: 'Game' }

async function write(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, JSON.stringify(value))
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'kl-app-store-'))
  test.data = join(root, 'data')
  test.resources = join(root, 'resources')
  test.encryption = true
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: test.resources })
})

afterEach(async () => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(process, 'resourcesPath')
  await fs.rm(root, { recursive: true, force: true })
})

describe('app configuration transactions', () => {
  it('merges disjoint field patches ahead of publication and returns independent snapshots', async () => {
    await write(AppStore.file(), { version: 14, apps: [app] })
    const stale = await AppStore.load()
    await Promise.all([
      AppStore.patchApp('app', { name: '新游戏' }),
      AppStore.patchApp('app', { gameDirectory: 'D:/测试/游戏' })
    ])
    stale.apps[0].name = 'stale'
    const entry = (await AppStore.load()).apps[0]
    expect(entry).toMatchObject({ name: '新游戏', gameDirectory: 'D:/测试/游戏' })
    expect(JSON.parse(await fs.readFile(AppStore.file(), 'utf8')).apps[0]).toEqual(entry)
  })

  it.each([
    [null, 'INVALID_CONFIG'],
    [{ version: 999, apps: [] }, 'UNSUPPORTED_CONFIG'],
    [{ apps: [{ ...app, wallpapers: [null] }] }, 'INVALID_CONFIG'],
    [{ apps: [{ ...app, wallpaperIndex: -1 }] }, 'INVALID_CONFIG'],
    [{ apps: [{ ...app, linkedLaunchIds: ['unavailable'] }] }, 'INVALID_CONFIG']
  ])('preserves invalid data (%j) and rejects the write', async (data, code) => {
    await write(AppStore.file(), data)
    await expect(AppStore.setGamesRowHidden(true)).rejects.toMatchObject({ code })
    expect(JSON.parse(await fs.readFile(AppStore.file(), 'utf8'))).toEqual(data)
  })

  it('preserves a deliberately emptied list after restart even with a nonempty old backup', async () => {
    await write(join(test.data, 'update-backup', 'config.json'), { version: 14, apps: [app] })
    await write(AppStore.file(), { version: 14, apps: [app] })
    await AppStore.mutate((draft) => { draft.apps = [] })
    await AppStore.reload()
    expect((await AppStore.load()).apps).toEqual([])
  })

  it('recovers a missing config from a valid nonempty backup', async () => {
    await write(join(test.data, 'update-backup', 'config.json'), { version: 14, apps: [app] })
    expect((await AppStore.load()).apps).toEqual([expect.objectContaining(app)])
    expect(JSON.parse(await fs.readFile(AppStore.file(), 'utf8')).apps).toHaveLength(1)
  })

  it('reports a missing replacement after quarantining a broken config and leaves it intact', async () => {
    await fs.mkdir(test.data)
    await fs.writeFile(AppStore.file(), '{"apps":')
    await expect(AppStore.load()).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    await expect(AppStore.setGamesRowHidden(true)).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    expect(await fs.readFile(`${AppStore.file()}.corrupt`, 'utf8')).toBe('{"apps":')
    await expect(fs.access(AppStore.file())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports an unreadable config without changing it', async () => {
    await fs.mkdir(AppStore.file(), { recursive: true })
    await expect(AppStore.setGamesRowHidden(true)).rejects.toMatchObject({ code: 'READ_FAILED' })
    expect((await fs.lstat(AppStore.file())).isDirectory()).toBe(true)
  })

  it('retains committed config and media when saving the new reference fails', async () => {
    const oldImage = join(test.data, 'icons', 'old.png')
    const newImage = join(test.data, 'icons', 'new.png')
    await write(AppStore.file(), { version: 14, apps: [{ ...app, iconFile: 'old.png' }] })
    await write(oldImage, 'original icon')
    await AppStore.load()
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation((source, target) =>
      target === AppStore.file() ? Promise.reject(new Error('disk full')) : rename(source, target))
    await expect(AppStore.mutateApp('app', async (draft) => {
      await write(newImage, 'replacement icon')
      draft.iconFile = 'new.png'
    })).rejects.toMatchObject({ code: 'SAVE_FAILED' })
    expect((await AppStore.load()).apps[0].iconFile).toBe('old.png')
    expect(await fs.readFile(oldImage, 'utf8')).toBe('"original icon"')
    await expect(fs.access(newImage)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains shared media until the last reference is removed', async () => {
    await write(AppStore.file(), {
      version: 14,
      apps: [{ ...app, iconFile: 'shared.png' }, { ...app, id: 'other', iconFile: 'shared.png' }]
    })
    const icon = join(test.data, 'icons', 'shared.png')
    await write(icon, 'image bytes')
    await AppStore.mutateApp('app', (entry) => { entry.iconFile = null })
    await expect(fs.access(icon)).resolves.toBeUndefined()
    await AppStore.mutateApp('other', (entry) => { entry.iconFile = null })
    await expect(fs.access(icon)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains the old shortcut icon if the Windows shell rejects a committed replacement', async () => {
    await write(AppStore.file(), { version: 14, apps: [], launcher: { iconFile: 'old.png' } })
    const oldIcon = join(test.data, 'brand', 'old.ico')
    await write(oldIcon, 'shortcut still uses this')
    await expect(AppStore.mutate(async (draft) => {
      await write(join(test.data, 'brand', 'new.png'), 'new image')
      draft.launcher!.iconFile = 'new.png'
    }, async () => { throw new Error('shortcut in use') })).rejects.toThrow('shortcut in use')
    expect((await AppStore.launcherSettings()).iconFile).toBe('new.png')
    await expect(fs.access(oldIcon)).resolves.toBeUndefined()
  })

  it('preserves the selected wallpaper across partial and duplicate reorder IDs', async () => {
    await write(AppStore.file(), { version: 14, apps: [{
      ...app,
      wallpapers: ['a', 'b', 'c'].map((id) => ({ id, file: `${id}.png`, name: id })),
      wallpaperIndex: 1
    }] })
    const entry = await AppStore.reorderWallpapers(app.id, ['c', 'a', 'a', 'missing'])
    expect(entry.wallpapers.map(({ id }) => id)).toEqual(['c', 'a', 'b'])
    expect(entry.wallpaperIndex).toBe(2)
  })

  it('uses the packaged policy after a stale local policy, then marks the intro only after display', async () => {
    const oldPolicy = { version: '2.0.4', themeId: 'default', areas: 'all', material: 'mica', launchEffect: 'glitch' }
    const bundled = {
      version: test.version, themeId: 'starsnow', areas: 'all', material: 'astral', launchEffect: 'nova',
      intro: { title: '新功能介绍', body: '这次更新的内容。', features: ['一次性介绍', '随包主题策略'] }
    }
    const oldPolicyFile = join(test.data, 'theme-policy.json')
    await write(AppStore.file(), { version: 14, apps: [app] })
    await write(oldPolicyFile, oldPolicy)
    await write(join(test.resources, `app-${test.version}`, 'theme-policy.json'), bundled)
    await recordUpgradeSource(test.data, '2.0.4', test.version, 'hot')

    const first = await applyUpgradeFeaturesOnReady()
    expect(first).toMatchObject({ changed: true, intro: { title: '新功能介绍' } })
    let config = await AppStore.load()
    expect(config.launcher).toMatchObject({
      themePolicyVersion: test.version,
      themePolicyApplied: [test.version],
      themeAreas: { dialogs: 'starsnow' }
    })
    expect(config.launcher?.featureIntroApplied).toEqual([])
    expect(config.apps[0]).toMatchObject({ glass: { material: 'astral' }, launchEffect: 'nova' })
    expect(JSON.parse(await fs.readFile(oldPolicyFile, 'utf8'))).toEqual(oldPolicy)

    expect(await completeUpgradeIntro()).toBe(true)
    expect((await AppStore.load()).launcher?.featureIntroApplied).toEqual([test.version])

    await AppStore.setLauncher({ themeAreas: { dialogs: 'default' } })
    await AppStore.mutateApp(app.id, (entry) => {
      entry.glass.material = 'mica'
      entry.launchEffect = 'shockwave'
    })
    await AppStore.reload()
    await recordUpgradeSource(test.data, '2.0.4', test.version, 'hot')
    expect(await applyUpgradeFeaturesOnReady()).toEqual({ changed: false, intro: null })
    expect((await AppStore.launcherSettings()).themeAreas.dialogs).toBe('default')
    expect((await AppStore.load()).apps[0]).toMatchObject({ glass: { material: 'mica' }, launchEffect: 'shockwave' })
  })

  it('applies an intro-only release once without changing theme fields', async () => {
    await write(AppStore.file(), {
      version: 14,
      apps: [app],
      launcher: { themeAreas: { dialogs: 'starsnow' }, themePolicyVersion: '2.0.4' }
    })
    await write(join(test.data, 'theme-policy.json'), {
      version: test.version,
      intro: { title: '只看介绍', features: ['不会改主题'] }
    })
    await recordUpgradeSource(test.data, '2.0.4', test.version, 'install')

    const result = await applyUpgradeFeaturesOnReady()
    expect(result).toMatchObject({ changed: false, intro: { title: '只看介绍' } })
    let config = await AppStore.load()
    expect(config.launcher).toMatchObject({
      themePolicyVersion: '2.0.4',
      themeAreas: { dialogs: 'starsnow' }
    })
    expect((await AppStore.launcherSettings()).featureIntroApplied).toEqual([])
    expect(config.apps[0].glass.material).toBe('blur')

    expect(await completeUpgradeIntro()).toBe(true)
    config = await AppStore.load()
    expect(config.launcher).toMatchObject({
      themePolicyVersion: '2.0.4',
      themeAreas: { dialogs: 'starsnow' },
      featureIntroApplied: [test.version]
    })
  })

  it('honors an existing theme marker while delivering its own introduction', async () => {
    await write(AppStore.file(), {
      version: 14,
      apps: [app],
      launcher: {
        themeAreas: { dialogs: 'mitia' },
        themePolicyVersion: test.version,
        themePolicyApplied: ['2.0.0']
      }
    })
    await write(join(test.data, 'theme-policy.json'), {
      version: test.version,
      themeId: 'starsnow',
      areas: 'all',
      intro: { title: '独立介绍', features: ['不覆盖旧主题标记'] }
    })
    await recordUpgradeSource(test.data, '2.0.4', test.version, 'install')

    expect(await applyUpgradeFeaturesOnReady()).toMatchObject({
      changed: false, intro: { title: '独立介绍' }
    })
    let config = await AppStore.load()
    expect(config.launcher).toMatchObject({
      themePolicyVersion: test.version,
      themeAreas: { dialogs: 'mitia' },
      themePolicyApplied: ['2.0.0']
    })
    expect(config.launcher?.featureIntroApplied).toBeUndefined()

    expect(await completeUpgradeIntro()).toBe(true)
    config = await AppStore.load()
    expect(config.launcher).toMatchObject({
      themePolicyVersion: test.version,
      themeAreas: { dialogs: 'mitia' },
      themePolicyApplied: ['2.0.0'],
      featureIntroApplied: [test.version]
    })
  })

  it('quietly skips a fresh install and a rolled-back target', async () => {
    await write(AppStore.file(), { version: 14, apps: [app] })
    await write(join(test.data, 'theme-policy.json'), {
      version: test.version,
      themeId: 'starsnow',
      areas: 'all',
      intro: { title: 'needs an upgrade proof', features: ['x'] }
    })
    expect(await applyUpgradeFeaturesOnReady()).toEqual({ changed: false, intro: null })

    await fs.rm(join(test.data, 'theme-policy.json'))
    await recordUpgradeSource(test.data, '2.0.4', test.version, 'hot')
    expect(await applyUpgradeFeaturesOnReady()).toEqual({ changed: false, intro: null })
    await expect(fs.access(join(test.data, 'upgrade-source.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })

    await recordUpgradeSource(test.data, '2.0.4', '2.0.6', 'hot')
    expect(await applyUpgradeFeaturesOnReady()).toEqual({ changed: false, intro: null })
    expect((await AppStore.load()).launcher?.themeAreas).toBeUndefined()
  })
})

describe('encrypted token persistence', () => {
  it('serializes different repository instances and protects a refreshed token from deletion', async () => {
    const left = new TokenStore()
    const right = new TokenStore()
    await Promise.all([left.set('one', 'a'), right.set('two', 'b')])
    await right.set('one', 'updated')
    await left.remove('one', 'a')
    expect(await left.get('one')).toBe('updated')
    expect(await right.get('two')).toBe('b')
    expect(Object.keys(JSON.parse(await fs.readFile(join(test.data, 'auth.json'), 'utf8')))).toEqual(['one', 'two'])
  })

  it('surfaces encryption or write failures without changing the old record', async () => {
    const tokens = new TokenStore()
    await tokens.set('one', 'old')
    test.encryption = false
    await expect(tokens.set('one', 'new')).rejects.toThrow('加密服务不可用')
    test.encryption = true
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation((source, target) =>
      target === join(test.data, 'auth.json') ? Promise.reject(new Error('disk full')) : rename(source, target))
    await expect(tokens.set('one', 'new')).rejects.toThrow('保存凭据失败')
    expect(await tokens.get('one')).toBe('old')
  })
})
