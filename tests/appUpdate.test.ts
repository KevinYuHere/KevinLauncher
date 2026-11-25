import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppUpdateChecker } from '../src/main/services/appUpdate'
import { parseUpdateManifest } from '../src/main/services/appUpdateManifest'

const mocks = vi.hoisted(() => ({
  data: '',
  openPath: vi.fn(async () => ''),
  quit: vi.fn(),
  relaunch: vi.fn(),
  exit: vi.fn(),
  extract: vi.fn(),
  backup: vi.fn(),
  flush: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => mocks.data,
    quit: mocks.quit,
    relaunch: mocks.relaunch,
    exit: mocks.exit
  },
  shell: { openPath: mocks.openPath }
}))
vi.mock('../src/main/services/appVersion', () => ({
  currentAppVersion: () => '2.0.4',
  loadedApplication: () => ({
    version: '2.0.4', directory: join(process.resourcesPath, 'app-2.0.4'), pending: false
  })
}))
vi.mock('../src/main/services/appStore', () => ({
  AppStore: { launcherSettings: async () => ({ updateChannel: 'stable' }) }
}))
vi.mock('../src/main/services/updateDownload', async importOriginal => ({
  ...await importOriginal<typeof import('../src/main/services/updateDownload')>(),
  extractPayload: mocks.extract
}))
vi.mock('../src/main/services/dataBackup', async importOriginal => ({
  ...await importOriginal<typeof import('../src/main/services/dataBackup')>(),
  backupUserData: mocks.backup
}))
vi.mock('../src/main/services/shutdown', () => ({ flushBeforeShutdown: mocks.flush }))
vi.mock('../src/main/services/behavior', () => ({ markQuitting: vi.fn() }))
vi.mock('../src/main/services/logger', () => ({ log: vi.fn() }))

const version = '2.0.5'
const asset = 'some exact bytes for the application update'
const sha256 = createHash('sha256').update(asset).digest('hex')
const installerName = `KevinLauncher-Installer-${version}.exe`
const originalRuntime = Object.getOwnPropertyDescriptor(process.versions, 'electron')
const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
let dir: string
let extractedVersion: string
const compatibility = { shellProtocol: 2, installProtocol: 1, dataSchema: 1, hostSha256: 'a'.repeat(64) }

const manifest = (electron: string, installer = false) => ({
  version, electron, appSize: 16384, payloadSize: Buffer.byteLength(asset), payloadSha256: sha256, compatibility,
  ...(installer ? { installerName, installerSize: Buffer.byteLength(asset), installerSha256: sha256 } : {})
})

beforeEach(async () => {
  vi.clearAllMocks()
  dir = await fs.mkdtemp(join(tmpdir(), 'app-update-test-'))
  extractedVersion = version
  mocks.data = join(dir, 'data')
  mocks.backup.mockResolvedValue({ status: 'complete', copied: 1, failed: 0 })
  Object.defineProperty(process.versions, 'electron', { configurable: true, value: '44.7.0' })
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: join(dir, 'resources') })
  await fs.mkdir(process.resourcesPath)
  await fs.writeFile(join(process.resourcesPath, 'release-compatibility.json'), JSON.stringify(compatibility))
  mocks.extract.mockImplementation(async (_archive: string, target: string) => {
    for (const file of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
      const path = join(target, file)
      await fs.mkdir(join(path, '..'), { recursive: true })
      await fs.writeFile(path, '')
    }
    await fs.writeFile(join(target, 'package.json'), JSON.stringify({ version: extractedVersion }))
    await fs.writeFile(join(target, 'release-compatibility.json'), JSON.stringify(compatibility))
  })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  if (originalRuntime) Object.defineProperty(process.versions, 'electron', originalRuntime)
  else Reflect.deleteProperty(process.versions, 'electron')
  if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources)
  else Reflect.deleteProperty(process, 'resourcesPath')
  await fs.rm(dir, { recursive: true, force: true })
})

function stubRelease(runtime: string, serve: () => string): ReturnType<typeof vi.fn> {
  const download = vi.fn(serve)
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.endsWith('/releases')) {
      return Response.json([{ tag_name: `v${version}`, assets: [{ name: 'update-manifest.json', id: 1 }] }])
    }
    if (input.endsWith('/releases/assets/1')) {
      // Unauthenticated asset API can return metadata despite HTTP 200.
      return Response.json({ name: 'update-manifest.json', size: 150 })
    }
    if (input.endsWith(`/releases/download/v${version}/update-manifest.json`)) {
      return Response.json(manifest(runtime, runtime !== '44.7.0'))
    }
    if (input.endsWith(`/KevinLauncher-${version}-app.zip`) || input.endsWith(`/${installerName}`)) {
      return new Response(download(), { status: 200 })
    }
    throw new Error(`Unexpected URL in test: ${input}`)
  }))
  return download
}

describe('update manifest integrity', () => {
  it('requires matching version, runtime and valid hashes for offered artifacts', () => {
    expect(() => parseUpdateManifest(JSON.stringify(manifest('44.7.0')), '3.0.0')).toThrow()
    expect(() => parseUpdateManifest(JSON.stringify(manifest('')))).toThrow()
    expect(() => parseUpdateManifest(JSON.stringify({
      ...manifest('44.7.0', true), installerSha256: null
    }))).toThrow()
    expect(parseUpdateManifest(JSON.stringify(manifest('44.7.0')), version).payloadSha256).toBe(sha256)
  })

  it('rejects a same-size corrupt hot-update payload before extraction and re-downloads on retry', async () => {
    let data = 'x'.repeat(Buffer.byteLength(asset))
    const download = stubRelease('44.7.0', () => data)
    const checker = new AppUpdateChecker()
    expect((await checker.check()).hasUpdate).toBe(true)
    checker.begin()
    await vi.waitFor(() => expect(checker.isRunning()).toBe(false))
    expect(checker.stateSnapshot()).toMatchObject({ phase: 'error', error: expect.stringContaining('SHA-256') })
    expect(mocks.extract).not.toHaveBeenCalled()
    expect(mocks.backup).not.toHaveBeenCalled()
    expect(await fs.readdir(join(mocks.data, 'update-staging', version))).toEqual([])

    data = asset
    checker.begin()
    await vi.waitFor(() => expect(checker.isRunning()).toBe(false))
    expect(download).toHaveBeenCalledTimes(2)
    expect(mocks.extract).toHaveBeenCalledTimes(1)
    expect(mocks.backup).toHaveBeenCalledTimes(1)
    expect(mocks.relaunch).toHaveBeenCalledTimes(1)
    expect(checker.stateSnapshot().installTotal).toBe(16384)
    expect(await fs.readFile(join(process.resourcesPath, 'app-version.txt'), 'utf8')).toBe(version)
  })

  it('tries another manifest URL and switches to a verified full installer after a runtime change', async () => {
    stubRelease('45.0.0', () => asset)
    const checker = new AppUpdateChecker()
    expect((await checker.check()).info?.electronVersion).toBe('45.0.0')
    checker.begin()
    await vi.waitFor(() => expect(checker.isRunning()).toBe(false))
    const installer = join(mocks.data, 'update-staging', version, installerName)
    expect(await fs.readFile(installer, 'utf8')).toBe(asset)
    expect(mocks.openPath).toHaveBeenCalledTimes(1)
    expect(mocks.openPath).toHaveBeenCalledWith(installer)
    expect(mocks.extract).not.toHaveBeenCalled()
    expect(mocks.quit).toHaveBeenCalledTimes(1)
  })

  it('keeps the current pointer if the unpacked application has a different version', async () => {
    extractedVersion = '2.0.4'
    stubRelease('44.7.0', () => asset)
    const pointer = join(process.resourcesPath, 'app-version.txt')
    await fs.writeFile(pointer, extractedVersion)
    const checker = new AppUpdateChecker()
    await checker.check()
    checker.begin()
    await vi.waitFor(() => expect(checker.isRunning()).toBe(false))
    expect(checker.stateSnapshot()).toMatchObject({ phase: 'error', error: expect.stringContaining('版本') })
    expect(await fs.readFile(pointer, 'utf8')).toBe(extractedVersion)
    expect(mocks.relaunch).not.toHaveBeenCalled()
  })

  it('retains the verified download and stops before extraction or pointer changes when backup fails', async () => {
    stubRelease('44.7.0', () => asset)
    mocks.backup.mockResolvedValue({ status: 'failed', copied: 0, failed: 1, message: '缺少壁纸' })
    const pointer = join(process.resourcesPath, 'app-version.txt')
    await fs.writeFile(pointer, '2.0.4')
    const checker = new AppUpdateChecker()
    await checker.check()
    checker.begin()
    await vi.waitFor(() => expect(checker.isRunning()).toBe(false))
    expect(checker.stateSnapshot()).toMatchObject({ phase: 'error', error: expect.stringContaining('缺少壁纸') })
    expect(mocks.extract).not.toHaveBeenCalled()
    expect(mocks.relaunch).not.toHaveBeenCalled()
    expect(await fs.readFile(pointer, 'utf8')).toBe('2.0.4')
    expect(await fs.readFile(join(mocks.data, 'update-staging', version, 'app.zip'), 'utf8')).toBe(asset)
  })

  it('leaves the existing app selected when final user-data saving fails, then reuses the download', async () => {
    const download = stubRelease('44.7.0', () => asset)
    const pointer = join(process.resourcesPath, 'app-version.txt')
    await fs.writeFile(pointer, '2.0.4')
    mocks.flush.mockRejectedValueOnce(new Error('写入用户数据失败'))
    const checker = new AppUpdateChecker()
    await checker.check()
    checker.begin()
    await vi.waitFor(() => expect(checker.isRunning()).toBe(false))
    expect(checker.stateSnapshot()).toMatchObject({ phase: 'error', message: expect.stringContaining('更新文件已准备好') })
    expect(await fs.readFile(pointer, 'utf8')).toBe('2.0.4')
    expect(mocks.relaunch).not.toHaveBeenCalled()
    checker.begin()
    await vi.waitFor(() => expect(checker.isRunning()).toBe(false))
    expect(download).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(pointer, 'utf8')).toBe(version)
  })
})
