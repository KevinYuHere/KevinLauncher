import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppUpdateChecker } from '../src/main/services/appUpdate'
import { parseBetaVerification, parseUpdateManifest } from '../src/main/services/appUpdateManifest'
import { pendingDataTransfer, runWithDataAccess, withShutdownDataAccess } from '../src/main/ipc/dataAccess'

const mocks = vi.hoisted(() => ({
  data: '',
  currentVersion: '2.0.4',
  channel: 'stable' as 'stable' | 'beta',
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
  currentAppVersion: () => mocks.currentVersion,
  loadedApplication: () => ({
    version: mocks.currentVersion, directory: join(process.resourcesPath, `app-${mocks.currentVersion}`), pending: false
  })
}))
vi.mock('../src/main/services/appStore', () => ({
  AppStore: { launcherSettings: async () => ({ updateChannel: mocks.channel }) }
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
vi.mock('../src/main/services/logger', () => ({ log: vi.fn(), flushLauncherLogs: async () => {} }))

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

const betaVersion = '3.0.0-beta.8'
const betaInstallerName = `KevinLauncher-Installer-${betaVersion}.exe`
const betaInstaller = 'verified beta installer bytes'
const betaInstallerSha = createHash('sha256').update(betaInstaller).digest('hex')
const betaVerification = {
  version: betaVersion,
  installer: betaInstallerName,
  size: Buffer.byteLength(betaInstaller),
  sha256: betaInstallerSha,
  installerMode: 'requireAdministrator',
  entryMode: 'requireAdministrator',
  runtimeMode: 'asInvoker'
}

function stableManifest(releaseVersion: string): Record<string, unknown> {
  return {
    version: releaseVersion,
    electron: '44.7.0',
    appSize: 16384,
    payloadSize: Buffer.byteLength(asset),
    payloadSha256: sha256,
    compatibility
  }
}

function betaRelease(assetSize = Buffer.byteLength(betaInstaller)) {
  return {
    tag_name: `v${betaVersion}`,
    name: `KevinLauncher ${betaVersion}`,
    body: `Beta ${betaVersion} notes`,
    prerelease: true,
    assets: [
      { name: 'beta-verification.json', id: 21 },
      { name: betaInstallerName, id: 20, size: assetSize }
    ]
  }
}

function stableRelease(releaseVersion: string) {
  return { tag_name: `v${releaseVersion}`, prerelease: false, assets: [] }
}

interface StubGitHubOptions {
  stableVersions?: string[]
  betaVerificationBody?: unknown
  deferredStableManifest?: { version: string; response: Promise<Response> }
}

function stubGitHub(releases: unknown[], options: StubGitHubOptions = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string) => {
    if (input.endsWith('/releases')) return Response.json(releases)
    const stableVersion = options.stableVersions?.find(item => input.endsWith(`/v${item}/update-manifest.json`))
    if (stableVersion) {
      if (options.deferredStableManifest?.version === stableVersion) {
        return options.deferredStableManifest.response
      }
      return Response.json(stableManifest(stableVersion))
    }
    if (input.endsWith('/releases/assets/21')) {
      return Response.json(options.betaVerificationBody ?? betaVerification)
    }
    if (input.endsWith('/releases/assets/20') || input.endsWith(`/${betaInstallerName}`)) {
      return new Response(betaInstaller, { status: 200 })
    }
    throw new Error(`Unexpected URL in test: ${input}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.currentVersion = '2.0.4'
  mocks.channel = 'stable'
  mocks.flush.mockImplementation(async (beforeDispose?: () => Promise<void>) => { await beforeDispose?.() })
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
  it('offers only a newer stable release when the installed application is a Beta', async () => {
    mocks.currentVersion = '2.0.6-beta.1'
    await fs.mkdir(mocks.data)
    await fs.writeFile(join(mocks.data, 'simulate-app-update.json'), JSON.stringify({ version: '9.9.9' }))
    stubRelease('44.7.0', () => asset)
    const checker = new AppUpdateChecker()
    expect(await checker.check()).toMatchObject({ current: mocks.currentVersion, hasUpdate: false, error: undefined })

    const available = '2.0.6'
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input.endsWith('/releases')) {
        return Response.json([
          { tag_name: 'v2.0.7-beta.1', prerelease: true },
          { tag_name: `v${available}` }
        ])
      }
      if (input.endsWith(`/v${available}/update-manifest.json`)) {
        return Response.json({ ...manifest('44.7.0'), version: available })
      }
      throw new Error(`Unexpected URL in test: ${input}`)
    }))
    expect(await checker.check('manual')).toMatchObject({
      current: mocks.currentVersion, hasUpdate: true, info: { version: available }
    })
  })

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

  it('reopens data access and retries the verified download when the version pointer cannot be written', async () => {
    const shutdown = await vi.importActual<typeof import('../src/main/services/shutdown')>('../src/main/services/shutdown')
    const disposed = vi.fn()
    shutdown.onBeforeShutdown(beforeDispose => withShutdownDataAccess(async () => {}, async () => {
      await beforeDispose?.()
      disposed()
    }))
    mocks.flush.mockImplementation(shutdown.flushBeforeShutdown)
    const download = stubRelease('44.7.0', () => asset)
    const pointer = join(process.resourcesPath, 'app-version.txt')
    const marker = join(process.resourcesPath, 'app-activation.json')
    const oldActivation = { schema: 1, healthy: '2.0.4', previousHealthy: '2.0.3' }
    await fs.writeFile(pointer, '2.0.4')
    await fs.writeFile(marker, JSON.stringify(oldActivation))
    const rename = fs.rename.bind(fs)
    let failPointer = true
    const replace = vi.spyOn(fs, 'rename').mockImplementation((source, target) => {
      if (target === pointer && failPointer) return Promise.reject(new Error('版本指针被占用'))
      return rename(source, target)
    })
    try {
      const checker = new AppUpdateChecker(pendingDataTransfer)
      await checker.check()
      checker.begin()
      await vi.waitFor(() => expect(checker.isRunning()).toBe(false))
      expect(checker.stateSnapshot()).toMatchObject({ phase: 'error', error: '版本指针被占用' })
      expect(await fs.readFile(pointer, 'utf8')).toBe('2.0.4')
      expect(JSON.parse(await fs.readFile(marker, 'utf8'))).toEqual(oldActivation)
      expect(mocks.relaunch).not.toHaveBeenCalled()
      expect(disposed).not.toHaveBeenCalled()
      await expect(runWithDataAccess('apps:update', () => 'saved')).resolves.toBe('saved')

      failPointer = false
      checker.begin()
      await vi.waitFor(() => expect(checker.isRunning()).toBe(false))
      expect(checker.stateSnapshot()).toMatchObject({ phase: 'done' })
      expect(download).toHaveBeenCalledOnce()
      expect(disposed).toHaveBeenCalledOnce()
      expect(mocks.relaunch).toHaveBeenCalledOnce()
      expect(await fs.readFile(pointer, 'utf8')).toBe(version)
    } finally {
      replace.mockRestore()
    }
  })
})

describe('update channels', () => {
  it('offers the verified installer-only beta.8 on the Beta channel', async () => {
    mocks.currentVersion = '3.0.0-beta.7'
    mocks.channel = 'beta'
    stubGitHub([betaRelease()])
    const checker = new AppUpdateChecker()
    const status = await checker.check('manual')
    expect(status).toMatchObject({
      hasUpdate: true,
      info: {
        version: betaVersion,
        payloadUrls: [],
        installerName: betaInstallerName,
        installerSize: Buffer.byteLength(betaInstaller),
        installerSha256: betaInstallerSha,
        critical: false
      }
    })

    checker.begin()
    await vi.waitFor(() => expect(checker.isRunning()).toBe(false))
    const installer = join(mocks.data, 'update-staging', betaVersion, betaInstallerName)
    expect(await fs.readFile(installer, 'utf8')).toBe(betaInstaller)
    expect(mocks.openPath).toHaveBeenCalledWith(installer)
    expect(mocks.extract).not.toHaveBeenCalled()
    expect(mocks.backup).not.toHaveBeenCalled()
    expect(mocks.quit).toHaveBeenCalledOnce()
    expect(checker.stateSnapshot().critical).toBe(false)
  })

  it('keeps Beta releases out of the stable channel', async () => {
    mocks.currentVersion = '2.0.5'
    const fetchMock = stubGitHub(
      [betaRelease(), stableRelease('2.0.6')],
      { stableVersions: ['2.0.6'] }
    )
    const status = await new AppUpdateChecker().check('manual')
    expect(status.info?.version).toBe('2.0.6')
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(betaVersion))).toBe(false)
  })

  it('lets a stable release win over a Beta by SemVer', async () => {
    mocks.currentVersion = '3.0.0-beta.7'
    mocks.channel = 'beta'
    stubGitHub(
      [betaRelease(), stableRelease('3.0.0')],
      { stableVersions: ['3.0.0'] }
    )
    const status = await new AppUpdateChecker().check('manual')
    expect(status.info?.version).toBe('3.0.0')
    expect(status.info?.payloadUrls.length).toBeGreaterThan(0)
  })

  it('skips legacy pre-releases without a verified installer pair', async () => {
    mocks.currentVersion = '1.3.0'
    mocks.channel = 'beta'
    const legacy = {
      tag_name: 'v2.0.0-beta.3',
      prerelease: true,
      assets: [{ name: 'KevinLauncher-Installer-2.0.0-beta.3.exe', id: 31 }]
    }
    stubGitHub(
      [legacy, stableRelease('2.0.0')],
      { stableVersions: ['2.0.0'] }
    )
    const status = await new AppUpdateChecker().check('manual')
    expect(status.info?.version).toBe('2.0.0')
  })

  it('rejects a Beta whose verification does not match the listed installer size', async () => {
    mocks.currentVersion = '3.0.0-beta.7'
    mocks.channel = 'beta'
    stubGitHub([betaRelease(Buffer.byteLength(betaInstaller) + 1)])
    const status = await new AppUpdateChecker().check('manual')
    expect(status.hasUpdate).toBe(false)
    expect(status.error).toContain('Beta')
  })

  it('validates the published Beta verification schema', () => {
    expect(parseBetaVerification(JSON.stringify(betaVerification), betaVersion)).toEqual({
      version: betaVersion,
      installer: betaInstallerName,
      size: Buffer.byteLength(betaInstaller),
      sha256: betaInstallerSha
    })
    expect(() => parseBetaVerification(JSON.stringify({
      ...betaVerification, version: '3.0.0-beta.08'
    }), '3.0.0-beta.08')).toThrow()
    expect(() => parseBetaVerification(JSON.stringify({
      ...betaVerification, installerMode: 'asInvoker'
    }), betaVersion)).toThrow()
  })

  it('keeps per-channel cooldowns and cached offers when switching channels', async () => {
    mocks.currentVersion = '2.0.5'
    mocks.channel = 'beta'
    const fetchMock = stubGitHub(
      [betaRelease(), stableRelease('2.0.6')],
      { stableVersions: ['2.0.6'] }
    )
    const checker = new AppUpdateChecker()
    expect((await checker.check('auto')).info?.version).toBe(betaVersion)

    // Explicit check immediately after the switch must not return the Beta offer.
    mocks.channel = 'stable'
    expect((await checker.check('auto')).info?.version).toBe('2.0.6')
    expect((await checker.check('manual')).info?.version).toBe('2.0.6')

    mocks.channel = 'beta'
    expect((await checker.check('manual')).info?.version).toBe(betaVersion)

    const cache = JSON.parse(await fs.readFile(join(mocks.data, 'update-check.json'), 'utf8')) as {
      channels: Record<string, { info?: { version?: string } }>
    }
    expect(cache.channels.stable.info?.version).toBe('2.0.6')
    expect(cache.channels.beta.info?.version).toBe(betaVersion)

    // A fresh checker reads both the automatic and manual state from disk.
    const calls = fetchMock.mock.calls.length
    const reloaded = new AppUpdateChecker()
    expect((await reloaded.check('auto')).info?.version).toBe(betaVersion)
    expect((await reloaded.check('manual')).info?.version).toBe(betaVersion)
    expect(fetchMock).toHaveBeenCalledTimes(calls)
  })

  it('does not return an in-flight check from the previous channel', async () => {
    mocks.currentVersion = '2.0.5'
    let resolveStable!: (response: Response) => void
    const stableResponse = new Promise<Response>(resolve => { resolveStable = resolve })
    const fetchMock = stubGitHub(
      [betaRelease(), stableRelease('2.0.6')],
      {
        stableVersions: ['2.0.6'],
        deferredStableManifest: { version: '2.0.6', response: stableResponse }
      }
    )
    const checker = new AppUpdateChecker()
    const first = checker.check('manual')
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) =>
      String(url).endsWith('/v2.0.6/update-manifest.json'))).toBe(true))

    mocks.channel = 'beta'
    const second = checker.check('manual')
    resolveStable(Response.json(stableManifest('2.0.6')))
    const [firstStatus, secondStatus] = await Promise.all([first, second])
    expect(firstStatus.info?.version).toBe(betaVersion)
    expect(secondStatus.info?.version).toBe(betaVersion)
  })
})
