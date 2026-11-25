import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { backupDataDirectory, requireBackup } from '../src/main/services/dataBackup'
import { recoverSettingsImport, restoreSettingsBackup } from '../src/main/services/settingsBackup'

let root: string
const oldConfig = '{"version":14,"apps":[{"id":"old","name":"Old"}]}'
const newConfig = '{"version":14,"apps":[{"id":"new","name":"New"}]}'
const playtime = (id: string) => JSON.stringify({ sessions: [
  { appId: id, startUtc: '2026-01-01T00:00:00Z', endUtc: '2026-01-01T00:00:15Z', durationSec: 15 }
] })

beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'kl-settings-backup-')) })
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

async function write(file: string, value: string): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  await fs.writeFile(file, value)
}

async function fixture() {
  const live = join(root, 'live')
  const extracted = join(root, 'extracted')
  await write(join(live, 'config.json'), oldConfig)
  await write(join(live, 'playtime.json'), playtime('old'))
  await write(join(extracted, 'config.json'), newConfig)
  await write(join(extracted, 'playtime.json'), playtime('new'))
  return { live, extracted }
}

describe('settings import', () => {
  it('validates every file before changing active stores', async () => {
    const { live, extracted } = await fixture()
    await write(join(extracted, 'playtime.json'), '{"sessions":null}')
    const reload = vi.fn()
    await expect(restoreSettingsBackup(extracted, live, reload)).rejects.toThrow('playtime.json')
    expect(reload).not.toHaveBeenCalled()
    expect(await fs.readFile(join(live, 'config.json'), 'utf8')).toBe(oldConfig)
    expect(await fs.readFile(join(live, 'playtime.json'), 'utf8')).toBe(playtime('old'))
  })

  it('restores both stores on a failure publishing the second file', async () => {
    const { live, extracted } = await fixture()
    const rename = fs.rename.bind(fs)
    const bad = join(live, 'import-staging', 'next', 'playtime.json')
    vi.spyOn(fs, 'rename').mockImplementation((from, to) =>
      from === bad ? Promise.reject(new Error('locked')) : rename(from, to)
    )
    const reload = vi.fn(async () => {
      expect(await fs.readFile(join(live, 'config.json'), 'utf8')).toBe(oldConfig)
      expect(await fs.readFile(join(live, 'playtime.json'), 'utf8')).toBe(playtime('old'))
    })
    await expect(restoreSettingsBackup(extracted, live, reload)).rejects.toThrow('locked')
    expect(reload).toHaveBeenCalledOnce()
    await expect(fs.access(join(live, 'import-staging'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reloads only after both new stores are published', async () => {
    const { live, extracted } = await fixture()
    const media = join('bg', '旧版.壁纸 🌌.png')
    await write(join(extracted, media), 'wallpaper bytes')
    const reload = vi.fn(async () => {
      expect(JSON.parse(await fs.readFile(join(live, 'config.json'), 'utf8'))).toEqual(JSON.parse(newConfig))
      expect(JSON.parse(await fs.readFile(join(live, 'playtime.json'), 'utf8'))).toEqual(JSON.parse(playtime('new')))
      expect(await fs.readFile(join(live, media), 'utf8')).toBe('wallpaper bytes')
    })
    await restoreSettingsBackup(extracted, live, reload)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('recovers the original through the same journal after a process stops during import', async () => {
    const { live } = await fixture()
    const work = join(live, 'import-staging')
    await write(join(work, 'previous', 'config.json'), oldConfig)
    await write(join(live, 'config.json'), newConfig)
    await write(join(live, 'auth.json'), '{}')
    await write(join(work, 'journal.json'), JSON.stringify({ complete: false, entries: [
      { name: 'config.json', existed: true }, { name: 'auth.json', existed: false }
    ] }))
    await recoverSettingsImport(live)
    expect(await fs.readFile(join(live, 'config.json'), 'utf8')).toBe(oldConfig)
    await expect(fs.access(join(live, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes persisted stores and media missing from a complete restore', async () => {
    const { live, extracted } = await fixture()
    await fs.rm(join(extracted, 'playtime.json'))
    await write(join(extracted, 'config.json'), '{"version":14,"apps":[]}')
    await write(join(live, 'auth.json'), '{}')
    await write(join(live, 'gacha', 'old.json'), '{"records":[]}')
    await write(join(live, 'bg', 'old.png'), 'old image')
    await write(join(live, 'thumbs', 'other-data'), 'different ownership')
    await restoreSettingsBackup(extracted, live, async () => {})
    expect(JSON.parse(await fs.readFile(join(live, 'config.json'), 'utf8')).apps).toEqual([])
    for (const file of ['playtime.json', 'auth.json', join('gacha', 'old.json'), join('bg', 'old.png')]) {
      await expect(fs.access(join(live, file))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await fs.readFile(join(live, 'thumbs', 'other-data'), 'utf8')).toBe('different ownership')
  })

  it.each(['missing.png', '../outside.png', 'CON.png'])('rejects unresolvable media %s before replacing any stores', async (file) => {
    const { live, extracted } = await fixture()
    await write(join(extracted, 'config.json'), JSON.stringify({
      version: 14, apps: [{ id: 'new', name: 'New', iconFile: file }]
    }))
    await expect(restoreSettingsBackup(extracted, live, async () => {})).rejects.toThrow(/媒体|配置/)
    expect(await fs.readFile(join(live, 'config.json'), 'utf8')).toBe(oldConfig)
  })
})

describe('pre-update snapshot', () => {
  it('distinguishes no data from incomplete data and refuses the latter before a commit', async () => {
    const live = join(root, 'fresh')
    await write(join(live, 'Cache', 'file'), 'derived')
    const none = await backupDataDirectory(live, 'fresh install')
    expect(none).toEqual({ status: 'not-needed', copied: 0, failed: 0 })
    expect(() => requireBackup(none)).not.toThrow()
    await write(join(live, 'playtime.json'), playtime('still-present'))
    const incomplete = await backupDataDirectory(live, 'missing config')
    expect(incomplete.status).toBe('failed')
    expect(() => requireBackup(incomplete)).toThrow('无法备份用户数据')
  })

  it('preserves the complete snapshot if configured media no longer exists', async () => {
    const { live } = await fixture()
    const old = join(live, 'update-backup', 'config.json')
    await write(old, oldConfig)
    await write(join(live, 'config.json'), JSON.stringify({
      version: 14, apps: [{ id: 'new', name: 'New', iconFile: 'missing.png' }]
    }))
    const result = await backupDataDirectory(live, 'test')
    expect(result.status).toBe('failed')
    expect(await fs.readFile(old, 'utf8')).toBe(oldConfig)
  })
  it('preserves the last complete snapshot when a data file fails to copy', async () => {
    const { live } = await fixture()
    const old = join(live, 'update-backup', 'config.json')
    await write(old, oldConfig)
    await write(join(live, 'config.json'), newConfig)
    const copyFile = fs.copyFile.bind(fs)
    vi.spyOn(fs, 'copyFile').mockImplementation((source, target) =>
      source === join(live, 'playtime.json') ? Promise.reject(new Error('locked')) : copyFile(source, target)
    )
    expect((await backupDataDirectory(live, 'test')).failed).toBe(1)
    expect(await fs.readFile(old, 'utf8')).toBe(oldConfig)
  })

  it('restores the old slot if the candidate cannot take its place', async () => {
    const { live } = await fixture()
    const slot = join(live, 'update-backup')
    await write(join(slot, 'config.json'), oldConfig)
    await write(join(live, 'config.json'), newConfig)
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation((from, target) =>
      String(from).startsWith(`${slot}.new-`) && target === slot
        ? Promise.reject(new Error('locked')) : rename(from, target)
    )
    expect((await backupDataDirectory(live, 'test')).failed).toBeGreaterThan(0)
    expect(await fs.readFile(join(slot, 'config.json'), 'utf8')).toBe(oldConfig)
  })
})
