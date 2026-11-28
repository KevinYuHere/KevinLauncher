import { lstatSync } from 'fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runPowerShellSync } from '../src/main/services/powershell'
import { assertTrialInstallDirectory, legacyTrialInstallDirectory, trialInstallDirectory } from '../src/main/services/buildIdentity'
import { defaultInstallDir, normalizeInstallDir, processesUsingInstall } from '../src/main/services/install'
import windowsLayout from '../src/shared/windowsLayout.json'

vi.mock('@shared/buildIdentity', () => ({ trialBuild: true }))
vi.mock('electron', () => ({ app: {} }))
vi.mock('fs', async importOriginal => {
  const fs = await importOriginal<typeof import('fs')>()
  return { ...fs, lstatSync: vi.fn(fs.lstatSync) }
})
vi.mock('../src/main/services/powershell', async importOriginal => ({
  ...await importOriginal<typeof import('../src/main/services/powershell')>(), runPowerShellSync: vi.fn()
}))

describe.skipIf(process.platform !== 'win32')('protected trial installation', () => {
  let root: string
  let programFiles: string
  let knownTarget: string
  let profile: string

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'trial-path-')))
    programFiles = join(root, '受保护程序')
    profile = join(root, '用户配置')
    await Promise.all([mkdir(programFiles), mkdir(profile)])
    vi.stubEnv('LOCALAPPDATA', profile)
    vi.stubEnv('ProgramFiles', profile)
    const sid = 'S-1-5-21-1-2-3-1000'
    vi.mocked(runPowerShellSync).mockReturnValue(`${programFiles}\r\n${sid}\r\n`)
    knownTarget = join(programFiles, 'KevinLauncherTrial', sid)
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })

  it('uses the Windows known folder and token SID for the only program target', () => {
    expect(defaultInstallDir()).toBe(knownTarget)
    expect(normalizeInstallDir(`${knownTarget}\\`)).toBe(knownTarget)
    expect(runPowerShellSync).toHaveBeenCalledWith(expect.stringContaining('SpecialFolder]::ProgramFiles'), { systemOnly: true })
    expect(() => assertTrialInstallDirectory(knownTarget)).not.toThrow()
    expect(() => assertTrialInstallDirectory(legacyTrialInstallDirectory())).toThrow('固定的试用目录')
  })

  it('rejects a redirected program directory', () => {
    vi.mocked(lstatSync).mockReturnValueOnce({
      isDirectory: () => true, isSymbolicLink: () => true
    } as ReturnType<typeof lstatSync>)
    expect(() => trialInstallDirectory()).toThrow('未重定向的实体目录')
  })

  it('finds an exact legacy instance without considering copies and other products', () => {
    const image = (pid: number, ppid: number, executable: string) => ({ pid, ppid, name: '', executable })
    const newEntry = join(knownTarget, windowsLayout.trialEntry)
    const newRuntime = join(knownTarget, windowsLayout.trialRuntime)
    const oldEntry = join(legacyTrialInstallDirectory(), windowsLayout.trialEntry)
    const snapshot = [image(1, 0, newEntry), image(2, 1, newRuntime), image(3, 0, oldEntry),
      image(4, 0, join(knownTarget, windowsLayout.entry)), image(5, 0, join(profile, windowsLayout.trialEntry))]
    expect(processesUsingInstall(snapshot, knownTarget, { pid: 2, ppid: 1, execPath: newRuntime })).toEqual([3])
  })
})
