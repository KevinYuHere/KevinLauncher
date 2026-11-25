import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPayload, listFiles, normalizeInstallDir, staleFiles } from '../src/main/services/install'

vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '2.0.5' } }))

const temporaryDirs = new Set<string>()

async function temp(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'install-test-'))
  temporaryDirs.add(dir)
  return dir
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all([...temporaryDirs].map(dir => fs.rm(dir, { recursive: true, force: true })))
  temporaryDirs.clear()
})

describe('staleFiles', () => {
  it('keeps only files that the new version no longer ships', () => {
    expect(staleFiles(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['a'])
  })

  it('never reports install.json (the marker is rewritten, not stale)', () => {
    expect(staleFiles(['install.json', 'old'], ['new'])).toEqual(['old'])
  })

  it('returns nothing when the file set is unchanged', () => {
    expect(staleFiles(['a', 'b'], ['a', 'b'])).toEqual([])
  })
})

describe('listFiles', () => {
  it('lists files recursively with forward slashes, sorted', async () => {
    const dir = await temp()
    await fs.mkdir(join(dir, 'resources', 'app'), { recursive: true })
    await fs.writeFile(join(dir, 'KevinLauncher.exe'), 'x')
    await fs.writeFile(join(dir, 'resources', 'app', 'main.js'), 'y')

    expect(await listFiles(dir)).toEqual(['KevinLauncher.exe', 'resources/app/main.js'])
  })

  it('returns an empty list for a missing directory', async () => {
    await expect(listFiles(join(tmpdir(), 'does-not-exist-' + Date.now()))).rejects.toThrow()
  })
})

describe.skipIf(process.platform !== 'win32')('Windows installation paths', () => {
  it.each([
    ['D:', 'D:\\KevinLauncher'],
    ['D:\\', 'D:\\KevinLauncher'],
    ['\\\\test-server.invalid\\share\\', '\\\\test-server.invalid\\share\\KevinLauncher'],
    ['\\\\test-server.invalid\\KevinLauncher', '\\\\test-server.invalid\\KevinLauncher\\KevinLauncher'],
    ['\\\\?\\UNC\\test-server.invalid\\KevinLauncher\\', '\\\\?\\UNC\\test-server.invalid\\KevinLauncher\\KevinLauncher'],
    ['\\\\test-server.invalid\\share\\KevinLauncher', '\\\\test-server.invalid\\share\\KevinLauncher']
  ])('places the program in a folder for %s', (input, expected) => {
    expect(normalizeInstallDir(input)).toBe(expected)
  })

  it.each([
    'D:\\',
    '\\\\test-server.invalid\\KevinLauncher',
    '\\\\?\\UNC\\test-server.invalid\\KevinLauncher\\'
  ])('rejects a direct install into %s before touching the filesystem', async root => {
    const lstat = vi.spyOn(fs, 'lstat').mockRejectedValue(new Error('unexpected filesystem access'))
    await expect(applyPayload('D:\\staged-source', root)).rejects.toThrow('不能安装到磁盘或共享目录的根目录')
    expect(lstat).not.toHaveBeenCalled()
  })
})

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, value] of Object.entries(files)) {
    await fs.mkdir(join(dir, path, '..'), { recursive: true })
    await fs.writeFile(join(dir, path), value)
  }
}

async function installFixture(): Promise<{ root: string; source: string; target: string }> {
  const root = await fs.realpath(await temp())
  const source = join(root, 'portable')
  const target = join(root, '目标 路径')
  const previous = {
    'KevinLauncher.exe': 'old executable',
    'provider.dll': 'old runtime',
    'resources/app-version.txt': '2.0.4',
    'resources/app-2.0.4/out/main/index.js': 'old main'
  }
  await writeTree(target, {
    ...previous,
    'install.json': JSON.stringify({ version: '2.0.4', files: Object.keys(previous) }),
    'my own data.txt': 'preserve this'
  })
  await writeTree(source, {
    'KevinLauncher.exe': 'new executable',
    'provider.dll': 'new runtime',
    'resources/app-version.txt': '2.0.5',
    'resources/app/loader.js': 'loader',
    'resources/app/out/main/index.js': 'shell',
    'resources/app-2.0.5/out/main/index.js': 'new main'
  })
  return { root, source, target }
}

async function expectOldVersion(target: string): Promise<void> {
  expect(await fs.readFile(join(target, 'resources/app-version.txt'), 'utf8')).toBe('2.0.4')
  expect(await fs.readFile(join(target, 'resources/app-2.0.4/out/main/index.js'), 'utf8')).toBe('old main')
  expect(await fs.readFile(join(target, 'provider.dll'), 'utf8')).toBe('old runtime')
  expect(JSON.parse(await fs.readFile(join(target, 'install.json'), 'utf8')).version).toBe('2.0.4')
}

describe('applyPayload', () => {
  it('stages next to the target even when mkdir rejects its existing parent like a Windows root', async () => {
    const { root, source, target } = await installFixture()
    const mkdir = fs.mkdir.bind(fs)
    const mockedMkdir = vi.spyOn(fs, 'mkdir').mockImplementation((path, options) => {
      if (path === root) {
        return Promise.reject(Object.assign(new Error('operation not permitted, mkdir ' + root), { code: 'EPERM' }))
      }
      return mkdir(path, options)
    })
    const mkdtemp = vi.spyOn(fs, 'mkdtemp')

    await applyPayload(source, target)

    expect(mockedMkdir).not.toHaveBeenCalledWith(root, { recursive: true })
    expect(mkdtemp).toHaveBeenCalledWith(join(root, '.kevin-install-'))
    expect(await fs.readFile(join(target, 'resources/app-version.txt'), 'utf8')).toBe('2.0.5')
    expect(await fs.readdir(root)).toHaveLength(2)
  })

  it('creates missing nested parents for a fresh installation', async () => {
    const { root, source } = await installFixture()
    const newTarget = join(root, 'new', 'nested', 'KevinLauncher')
    await applyPayload(source, newTarget)
    expect(await fs.readFile(join(newTarget, 'resources/app-version.txt'), 'utf8')).toBe('2.0.5')
  })

  it('preserves a real permission denial when creating the lease', async () => {
    const { root, source, target } = await installFixture()
    const denied = Object.assign(new Error('permission denied while creating the lease'), { code: 'EACCES' })
    vi.spyOn(fs, 'mkdtemp').mockRejectedValueOnce(denied)
    await expect(applyPayload(source, target)).rejects.toBe(denied)
    await expectOldVersion(target)
    expect(await fs.readdir(root)).toHaveLength(2)
  })

  it('keeps the original installation intact on a copy error, then supports retry', async () => {
    const { root, source, target } = await installFixture()
    const copy = fs.copyFile.bind(fs)
    const mock = vi.spyOn(fs, 'copyFile').mockImplementation((from, to, mode) => {
      if (String(from).startsWith(source) && String(from).endsWith('provider.dll')) {
        return Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
      }
      return copy(from, to, mode)
    })
    await expect(applyPayload(source, target)).rejects.toThrow('disk full')
    await expectOldVersion(target)
    expect(await fs.readdir(root)).toHaveLength(2)
    mock.mockRestore()

    await applyPayload(source, target)
    expect(await fs.readFile(join(target, 'resources/app-version.txt'), 'utf8')).toBe('2.0.5')
    expect(await fs.readFile(join(target, 'resources/app-2.0.5/out/main/index.js'), 'utf8')).toBe('new main')
    expect(await fs.readFile(join(target, 'provider.dll'), 'utf8')).toBe('new runtime')
    expect(await fs.readFile(join(target, 'my own data.txt'), 'utf8')).toBe('preserve this')
    expect(JSON.parse(await fs.readFile(join(target, 'install.json'), 'utf8')).version).toBe('2.0.5')
    expect(await listFiles(target)).not.toContain('resources/app-2.0.4/out/main/index.js')
    expect(await fs.readdir(root)).toHaveLength(2)
  })

  it('restores the old directory if promotion fails after it was moved', async () => {
    const { root, source, target } = await installFixture()
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation((from, to) => {
      if (String(from).endsWith('next') && to === target) {
        return Promise.reject(Object.assign(new Error('promotion failed'), { code: 'EIO' }))
      }
      return rename(from, to)
    })
    await expect(applyPayload(source, target)).rejects.toThrow('promotion failed')
    await expectOldVersion(target)
    expect(await fs.readdir(root)).toHaveLength(2)
  })

  it('recovers an interrupted directory swap on the next install', async () => {
    const { root, source, target } = await installFixture()
    const interrupted = `${target}.kevin-install`
    const owner = 424242
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    await fs.mkdir(interrupted)
    await fs.rename(target, join(interrupted, 'previous'))
    await fs.writeFile(join(interrupted, 'transaction.json'), JSON.stringify({ target, owner, id }))
    const kill = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === owner && signal === 0) throw Object.assign(new Error('dead process'), { code: 'ESRCH' })
      return kill(pid, signal)
    })

    await applyPayload(source, target)
    expect(await fs.readFile(join(target, 'resources/app-version.txt'), 'utf8')).toBe('2.0.5')
    expect(await fs.readFile(join(target, 'my own data.txt'), 'utf8')).toBe('preserve this')
    expect(await fs.readFile(join(root, `.kevin-install-retired-${id}/previous/provider.dll`), 'utf8'))
      .toBe('old runtime')
  })

  it('rejects another installer while a live process owns the filesystem lease', async () => {
    const { source, target } = await installFixture()
    const lease = `${target}.kevin-install`
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    await fs.mkdir(lease)
    const journal = JSON.stringify({ target, owner: process.pid, id })
    await fs.writeFile(join(lease, 'transaction.json'), journal)
    await expect(applyPayload(source, target)).rejects.toThrow('已在安装到该目录')
    await expectOldVersion(target)
    expect(await fs.readFile(join(lease, 'transaction.json'), 'utf8')).toBe(journal)
  })

  it('holds the lease across preparation and committed metadata updates', async () => {
    const { root, source, target } = await installFixture()
    const steps: string[] = []
    await applyPayload(source, target, undefined, {
      beforeStage: async () => {
        steps.push('prepare')
        await expectOldVersion(target)
        await expect(applyPayload(source, target)).rejects.toThrow('已在安装到该目录')
      },
      afterCommit: async freshInstall => {
        steps.push('metadata')
        expect(freshInstall).toBe(false)
        expect(await fs.readFile(join(target, 'resources/app-version.txt'), 'utf8')).toBe('2.0.5')
        await expect(applyPayload(source, target)).rejects.toThrow('已在安装到该目录')
      }
    })
    expect(steps).toEqual(['prepare', 'metadata'])
    expect(await fs.readdir(root)).toHaveLength(2)
  })
})
