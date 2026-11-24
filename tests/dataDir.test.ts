import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { isTransientEntry, migrateDataDirectory, normalizeDataDir, seedDataDir } from '../src/main/services/dataDir'

const roots: string[] = []
async function makeDir(prefix: string): Promise<string> {
  // Migration intentionally retains sources reached through an alias. These
  // fixtures exercise direct paths even when Windows TEMP itself is aliased.
  const dir = await fs.mkdtemp(join(await fs.realpath(tmpdir()), prefix))
  roots.push(dir)
  return dir
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('seedDataDir', () => {
  it('seeds and commits when mkdir rejects the existing parent like a Windows root', async () => {
    const root = await makeDir('kl-seed-root-')
    const fallback = join(root, 'default')
    const target = join(root, 'KevinLauncherData')
    await fs.mkdir(join(fallback, 'update-backup'), { recursive: true })
    await fs.writeFile(join(fallback, 'config.json'), '{"apps":["current"]}')
    await fs.writeFile(join(fallback, 'update-backup', 'config.json'), '{"apps":["backup"]}')
    const mkdir = fs.mkdir.bind(fs)
    const mockedMkdir = vi.spyOn(fs, 'mkdir').mockImplementation((path, options) => {
      if (path === root) {
        return Promise.reject(Object.assign(new Error('operation not permitted, mkdir ' + root), { code: 'EPERM' }))
      }
      return mkdir(path, options)
    })
    const mkdtemp = vi.spyOn(fs, 'mkdtemp')
    const commit = vi.fn(async (published: string) => {
      expect(await fs.readFile(join(published, 'config.json'), 'utf8')).toBe('{"apps":["current"]}')
      expect(await fs.readFile(join(published, 'update-backup', 'config.json'), 'utf8')).toBe('{"apps":["backup"]}')
      expect(await fs.readFile(join(fallback, 'config.json'), 'utf8')).toBe('{"apps":["current"]}')
    })

    await expect(seedDataDir(target, fallback, commit)).resolves.toEqual({ copied: 2, failed: 0, keptExisting: false })

    expect(commit.mock.calls).toEqual([[target]])
    expect(mockedMkdir).not.toHaveBeenCalledWith(root, { recursive: true })
    expect(mkdtemp).toHaveBeenCalledWith(join(root, '.kevin-data-move-'))
    expect(await fs.readdir(root)).toEqual(['KevinLauncherData'])
  })

  it('seeds an empty target from the default directory', async () => {
    const root = await makeDir('kl-seed-')
    const fallback = join(root, 'default')
    const target = join(root, 'custom')
    await fs.mkdir(fallback, { recursive: true })
    await fs.writeFile(join(fallback, 'config.json'), '{"apps":[]}')
    await fs.writeFile(join(fallback, 'playtime.json'), '{"sessions":[]}')

    const result = await seedDataDir(target, fallback)
    expect(result.copied).toBeGreaterThan(0)
    expect(result.keptExisting).toBe(false)
    expect(await fs.readFile(join(target, 'playtime.json'), 'utf8')).toBe('{"sessions":[]}')
    // The old directory is removed once the copy succeeded.
    await expect(fs.access(fallback)).rejects.toBeTruthy()
  })

  it('never overwrites a target that already holds data', async () => {
    const root = await makeDir('kl-seed-')
    const fallback = join(root, 'default')
    const target = join(root, 'custom')
    await fs.mkdir(fallback, { recursive: true })
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(join(fallback, 'config.json'), '{"apps":[]}')
    await fs.writeFile(join(fallback, 'playtime.json'), '{"sessions":["old"]}')
    await fs.writeFile(join(target, 'config.json'), '{"apps":["x"]}')
    await fs.writeFile(join(target, 'playtime.json'), '{"sessions":["new"]}')

    const result = await seedDataDir(target, fallback)
    expect(result.keptExisting).toBe(true)
    expect(result.copied).toBe(0)
    // The newer target data survives, the default directory is left alone.
    expect(await fs.readFile(join(target, 'playtime.json'), 'utf8')).toBe('{"sessions":["new"]}')
    expect(await fs.readFile(join(fallback, 'playtime.json'), 'utf8')).toBe('{"sessions":["old"]}')
  })
})

describe.skipIf(process.platform !== 'win32')('Windows data paths', () => {
  it.each([
    ['D:\\', 'D:\\KevinLauncherData'],
    ['\\\\test-server.invalid\\KevinLauncherData', '\\\\test-server.invalid\\KevinLauncherData\\KevinLauncherData'],
    ['\\\\?\\UNC\\test-server.invalid\\KevinLauncherData\\',
     '\\\\?\\UNC\\test-server.invalid\\KevinLauncherData\\KevinLauncherData'],
    ['\\\\test-server.invalid\\share\\KevinLauncherData', '\\\\test-server.invalid\\share\\KevinLauncherData']
  ])('selects a data subdirectory for %s', (input, expected) => {
    expect(normalizeDataDir(input)).toBe(expected)
  })

  it.each([
    'D:\\',
    '\\\\test-server.invalid\\KevinLauncherData',
    '\\\\?\\UNC\\test-server.invalid\\KevinLauncherData\\'
  ])('rejects seeding directly into %s before touching the filesystem', async root => {
    const realpath = vi.spyOn(fs, 'realpath').mockRejectedValue(new Error('unexpected filesystem access'))
    const commit = vi.fn()
    await expect(seedDataDir(root, 'D:\\default-data', commit)).rejects.toThrow('不能将磁盘或共享目录的根目录用作数据目录')
    expect(realpath).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })
})

describe('migrateDataDirectory', () => {
  async function fixture() {
    const root = await makeDir('kl-migrate-')
    const from = join(root, 'source')
    const to = join(root, 'target')
    await fs.mkdir(from)
    await fs.writeFile(join(from, 'config.json'), '{"apps":[]}')
    return { from, to }
  }

  it('copies after a session checkpoint and commits while the old data is still available', async () => {
    const { from, to } = await fixture()
    await migrateDataDirectory(from, to, async (published) => {
      expect(await fs.readFile(join(published, 'playtime.json'), 'utf8')).toBe('last played')
      await expect(fs.access(from)).resolves.toBeUndefined()
    }, {
      beforeCopy: () => fs.writeFile(join(from, 'playtime.json'), 'last played')
    })
    await expect(fs.access(from)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves the source and original empty destination when the registry commit fails', async () => {
    const { from, to } = await fixture()
    await fs.mkdir(to)
    await expect(migrateDataDirectory(from, to, async () => {
      throw new Error('registry unavailable')
    })).rejects.toThrow('registry unavailable')
    expect(await fs.readdir(to)).toEqual([])
    expect(await fs.readFile(join(from, 'config.json'), 'utf8')).toBe('{"apps":[]}')
  })

  it('aborts before publishing if a file copy fails', async () => {
    const { from, to } = await fixture()
    const file = join(from, 'playtime.json')
    await fs.writeFile(file, '{"sessions":[]}')
    const copyFile = fs.copyFile.bind(fs)
    vi.spyOn(fs, 'copyFile').mockImplementation((source, destination) =>
      String(source).toLowerCase() === file.toLowerCase()
        ? Promise.reject(new Error('file locked')) : copyFile(source, destination)
    )
    const commit = vi.fn()
    await expect(migrateDataDirectory(from, to, commit)).rejects.toThrow('已保留原数据目录')
    expect(commit).not.toHaveBeenCalled()
    await expect(fs.access(to)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.access(file)).resolves.toBeUndefined()
  })

  it('rejects containment', async () => {
    const { from, to } = await fixture()
    const commit = vi.fn()
    await expect(migrateDataDirectory(from, join(from, 'nested'), commit)).rejects.toThrow('互相包含')
    await expect(fs.access(to)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(commit).not.toHaveBeenCalled()
  })

  it('merges into a nonempty target, retaining unrelated files and taking the source value on overlap', async () => {
    const { from, to } = await fixture()
    await fs.mkdir(to)
    await fs.writeFile(join(to, 'owned.txt'), 'keep')
    await fs.writeFile(join(to, 'config.json'), '{"apps":["previous"]}')
    await migrateDataDirectory(from, to, async () => {})
    expect(await fs.readFile(join(to, 'owned.txt'), 'utf8')).toBe('keep')
    expect(await fs.readFile(join(to, 'config.json'), 'utf8')).toBe('{"apps":[]}')
  })

  it('restores the entire original nonempty target when the registry write fails', async () => {
    const { from, to } = await fixture()
    await fs.mkdir(to)
    await fs.writeFile(join(to, 'owned.txt'), 'keep')
    await fs.writeFile(join(to, 'config.json'), '{"apps":["previous"]}')
    await expect(migrateDataDirectory(from, to, async () => {
      throw new Error('registry unavailable')
    })).rejects.toThrow('registry unavailable')
    expect(await fs.readFile(join(to, 'owned.txt'), 'utf8')).toBe('keep')
    expect(await fs.readFile(join(to, 'config.json'), 'utf8')).toBe('{"apps":["previous"]}')
    expect(await fs.readFile(join(from, 'config.json'), 'utf8')).toBe('{"apps":[]}')
  })

  it('preserves both trees if a target directory occupies a source file path', async () => {
    const { from, to } = await fixture()
    await fs.mkdir(join(to, 'config.json'), { recursive: true })
    const commit = vi.fn()
    await expect(migrateDataDirectory(from, to, commit)).rejects.toThrow('目标已存在不同类型的同名项目：config.json')
    expect((await fs.stat(join(to, 'config.json'))).isDirectory()).toBe(true)
    expect(commit).not.toHaveBeenCalled()
  })

  it('does not switch to a corrupt configuration', async () => {
    const { from, to } = await fixture()
    await fs.writeFile(join(from, 'config.json'), '{"apps":')
    const commit = vi.fn()
    await expect(migrateDataDirectory(from, to, commit)).rejects.toThrow('配置读取失败')
    expect(commit).not.toHaveBeenCalled()
    await expect(fs.access(from)).resolves.toBeUndefined()
  })
})

describe('isTransientEntry', () => {
  it('skips caches, staging and the pre-update backup slot', () => {
    for (const name of [
      'thumbs',
      'update-staging',
      'logs',
      'update-backup',
      'update-backup.new',
      'launcher.log',
      'GPUCache'
    ]) {
      expect(isTransientEntry(name)).toBe(true)
    }
  })

  it('keeps real user data', () => {
    for (const name of ['config.json', 'playtime.json', 'bg', 'icons', 'gacha', 'brand']) {
      expect(isTransientEntry(name)).toBe(false)
    }
  })
})
