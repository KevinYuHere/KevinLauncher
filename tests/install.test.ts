import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPayload, listFiles, normalizeInstallDir, processesUsingInstall, staleFiles } from '../src/main/services/install'
import { managedUninstallPaths, uninstallHelperScript } from '../src/main/services/uninstall'
import { psQuote, runPowerShellFile, startDetachedPowerShellFile } from '../src/main/services/powershell'
import { launcherEntryPath } from '../src/main/services/buildIdentity'

vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '2.0.5' } }))

const temporaryDirs = new Set<string>()

async function temp(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'install-test-'))
  temporaryDirs.add(dir)
  return dir
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all([...temporaryDirs].map(dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })))
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

describe('managed uninstall', () => {
  it('keeps the uninstaller entry and its sandboxed descendants while identifying exact target processes', () => {
    const target = join('installations', '目标目录')
    const entry = join(target, 'KevinLauncher.exe')
    const runtime = join(target, 'KevinLauncherRuntime.exe')
    const process = (pid: number, ppid: number, executable: string) => ({ pid, ppid, executable, name: '' })
    const snapshot = [
      process(1, 0, entry), process(2, 1, runtime), process(3, 2, runtime), process(4, 3, runtime),
      process(5, 0, entry), process(6, 5, runtime),
      process(7, 0, join('another installation', 'KevinLauncher.exe'))
    ]
    expect(launcherEntryPath(runtime)).toBe(entry)
    expect(launcherEntryPath(entry)).toBe(entry)
    expect(processesUsingInstall(snapshot, target, { pid: 2, ppid: 1, execPath: runtime })).toEqual([5, 6])
    expect(processesUsingInstall(snapshot, target, { pid: 22, ppid: 0, execPath: 'setup.exe' }))
      .toEqual([1, 2, 3, 4, 5, 6])
  })

  it('uses only the validated recorded file set', () => {
    expect(managedUninstallPaths(['KevinLauncher.exe', 'resources/app/main.js', 'INSTALL.JSON']))
      .toEqual(['KevinLauncher.exe', 'resources/app/main.js', 'INSTALL.JSON'])
    expect(() => managedUninstallPaths(['KevinLauncher.exe', '../other.txt'])).toThrow('无效路径')
    expect(() => managedUninstallPaths(['KevinLauncher.exe', 'C:/shared.exe'])).toThrow('无效路径')
    expect(() => managedUninstallPaths(['KevinLauncher.exe', 'notes.txt '])).toThrow('无效路径')
  })

  it.skipIf(process.platform !== 'win32')('removes managed files from a Chinese path and preserves unknown files', async () => {
    const root = await fs.realpath(await temp())
    const installDir = join(root, '安装 甲')
    await writeTree(installDir, {
      'KevinLauncher.exe': 'installed',
      'resources/中文 模块.dll': 'component',
      'my files/私有记录.txt': 'keep',
      'install.json': '{}'
    })
    const report = join(root, '卸载结果.txt')
    const ready = join(root, '准备完成')
    const commit = join(root, '确认卸载')
    const backup = join(root, '保留的程序')
    const script = join(root, '卸载程序.ps1')
    await fs.writeFile(commit, 'commit')
    await fs.writeFile(script, '\uFEFF' + uninstallHelperScript({
      installDir, dataDir: undefined, backup, report, ready, commit,
      files: managedUninstallPaths(['KevinLauncher.exe', 'resources/中文 模块.dll'])
    }))
    await startDetachedPowerShellFile(script)
    await vi.waitFor(async () => {
      expect((await fs.readFile(report, 'utf8')).replace(/^\uFEFF/, '')).toBe('complete')
    }, { timeout: 10000 })
    expect(await listFiles(installDir)).toEqual(['my files/私有记录.txt'])
  }, 12000)

  it.skipIf(process.platform !== 'win32')('keeps system entries on file rollback and resumes cleanup after commit', async () => {
    const root = await fs.realpath(await temp())
    const installDir = join(root, '运行位置')
    const file = join(installDir, 'KevinLauncher.exe')
    const failurePoint = join(installDir, 'locked.dll')
    const report = join(root, 'result.txt')
    const ready = join(root, 'ready')
    const commit = join(root, 'commit')
    const backup = join(root, 'quarantine')
    const script = join(root, 'helper.ps1')
    const systemEntry = join(root, 'system-entry')
    const allowCleanup = join(root, 'allow-cleanup')
    await writeTree(installDir, { 'KevinLauncher.exe': 'program', 'install.json': '{}' })
    await fs.mkdir(failurePoint)
    await fs.writeFile(systemEntry, 'keep until committed')
    const stage = async () => {
      await fs.writeFile(commit, 'commit')
      await fs.writeFile(script, '\uFEFF' + uninstallHelperScript({
        installDir, dataDir: undefined, backup, report, ready, commit,
        files: managedUninstallPaths(['KevinLauncher.exe', 'locked.dll']),
        cleanup: `if (!(Test-Path -LiteralPath ${psQuote(allowCleanup)})) { throw 'cleanup fixture' }
Remove-Item -LiteralPath ${psQuote(systemEntry)} -ErrorAction Stop`
      }))
    }

    await stage()
    await expect(runPowerShellFile(script, 10000)).rejects.toThrow()
    expect((await fs.readFile(report, 'utf8')).replace(/^\uFEFF/, '')).toMatch(/^failed: Expected file/)
    expect(await fs.readFile(file, 'utf8')).toBe('program')
    expect(await fs.readFile(systemEntry, 'utf8')).toBe('keep until committed')

    await fs.rmdir(failurePoint)
    await fs.rmdir(backup)
    await stage()
    await expect(runPowerShellFile(script, 10000)).rejects.toThrow()
    expect((await fs.readFile(report, 'utf8')).replace(/^\uFEFF/, '')).toMatch(/^cleanup pending: cleanup fixture/)
    await expect(fs.access(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(systemEntry, 'utf8')).toBe('keep until committed')

    await fs.writeFile(allowCleanup, 'yes')
    await runPowerShellFile(script, 10000, ['-ResumeCleanup'])
    expect((await fs.readFile(report, 'utf8')).replace(/^\uFEFF/, '')).toBe('complete')
    await expect(fs.access(systemEntry)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30000)
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
  it('preserves the old tree on system setup failure and resumes the post-commit phase', async () => {
    const { root, source, target } = await installFixture()
    const afterCommit = vi.fn<() => Promise<void>>(async () => { throw new Error('shortcut write denied') })
    const lifecycle = { beforeStage: async () => {}, afterCommit }
    await expect(applyPayload(source, target, undefined, lifecycle)).rejects.toThrow('系统设置尚未完成')
    const saved = (await fs.readdir(root)).find(name => name.startsWith('.kevin-install-retired-'))
    expect(saved).toBeDefined()
    await expectOldVersion(join(root, saved!, 'previous'))
    expect(await fs.readFile(join(target, 'KevinLauncher.exe'), 'utf8')).toBe('new executable')
    afterCommit.mockResolvedValueOnce(undefined)
    const onProgress = vi.fn()
    await applyPayload(source, target, onProgress, lifecycle)
    expect(afterCommit).toHaveBeenCalledTimes(2)
    expect(onProgress).not.toHaveBeenCalled()
    expect(await fs.readdir(root)).not.toContain(saved)
    expect(await fs.readFile(join(target, 'my own data.txt'), 'utf8')).toBe('preserve this')
  })
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
  }, 20_000)

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
