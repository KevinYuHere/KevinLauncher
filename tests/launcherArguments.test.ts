import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Launcher } from '../src/main/services/launcher'
import { windowsCommandLine } from '../src/main/services/windowsArguments'
import { isElevated } from '../src/main/services/elevation'
import { runPowerShell } from '../src/main/services/powershell'

vi.mock('electron', () => ({
  shell: { readShortcutLink: () => ({ target: 'D:\\游戏\\game.exe' }) }
}))
vi.mock('../src/main/services/elevation', () => ({ isElevated: vi.fn() }))
vi.mock('../src/main/services/powershell', async importOriginal => ({
  ...await importOriginal<typeof import('../src/main/services/powershell')>(), runPowerShell: vi.fn()
}))
vi.mock('../src/main/services/logger', () => ({ log() {} }))

// Detached native helpers can start slowly on busy Windows CI runners, so the
// three real dispatch probes get a bounded wait wider than Vitest's 1s default.
const DETACHED_PROBE_WAIT_MS = 10_000
const DETACHED_PROBE_TEST_TIMEOUT_MS = 15_000

let temp: string
beforeEach(async () => {
  temp = await fs.mkdtemp(join(tmpdir(), 'kl-launch-args-'))
  vi.mocked(isElevated).mockResolvedValue(true)
})
afterEach(async () => {
  vi.clearAllMocks()
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe.skipIf(process.platform !== 'win32')('Windows launch dispatch', () => {
  it('passes native argv, environment and working directory through a real executable', async () => {
    const script = join(temp, '参数 拷贝.cjs')
    const result = join(temp, 'args.json')
    await fs.writeFile(script, "require('node:fs').writeFileSync(process.env.KEVIN_PROBE_OUT,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),custom:process.env.KEVIN_PROBE_ENV}))")
    const args = ['含 空格', '字面"引号', '%literal%!&', 'D:\\有空格\\', '']
    const launch = await Launcher.launch({
      targetPath: process.execPath, arguments: windowsCommandLine([script, ...args]),
      workingDirectory: temp, runAsAdmin: false,
      environmentVariables: { KEVIN_PROBE_OUT: result, KEVIN_PROBE_ENV: '值 & %' }
    })
    expect(launch).toMatchObject({ ok: true, confirmation: 'started' })
    await vi.waitFor(async () => {
      const saved = JSON.parse(await fs.readFile(result, 'utf8'))
      expect({ ...saved, cwd: await fs.realpath(saved.cwd) }).toEqual({ args, cwd: await fs.realpath(temp), custom: '值 & %' })
    }, { timeout: DETACHED_PROBE_WAIT_MS })
  }, DETACHED_PROBE_TEST_TIMEOUT_MS)

  it('passes spaces, a trailing backslash and cmd metacharacters through a real batch file', async () => {
    const script = join(temp, '测试 & 参数.cmd')
    const result = join(temp, 'args.json')
    const capture = join(temp, 'capture.cjs')
    await fs.writeFile(script, '@echo off\r\nset "KEVIN_PROBE_ONE=%~1"\r\nset "KEVIN_PROBE_TWO=%~2"\r\n"%KEVIN_PROBE_NODE%" "%KEVIN_PROBE_CAPTURE%"\r\n')
    await fs.writeFile(capture, "require('node:fs').writeFileSync(process.env.KEVIN_PROBE_OUT,JSON.stringify([process.env.KEVIN_PROBE_ONE,process.env.KEVIN_PROBE_TWO]))")
    const args = ['A & %PATH%! B', 'D:\\游戏 目录\\']
    const launch = await Launcher.launch({
      targetPath: script, arguments: windowsCommandLine(args), workingDirectory: temp,
      runAsAdmin: false, environmentVariables: {
        KEVIN_PROBE_OUT: result, KEVIN_PROBE_NODE: process.execPath, KEVIN_PROBE_CAPTURE: capture
      }
    })
    expect(launch).toMatchObject({ ok: true, confirmation: 'requested' })
    await vi.waitFor(async () => {
      expect(JSON.parse(await fs.readFile(result, 'utf8'))).toEqual(args)
    }, { timeout: DETACHED_PROBE_WAIT_MS })
  }, DETACHED_PROBE_TEST_TIMEOUT_MS)

  it('passes an argument and an environment override through Windows PowerShell -File', async () => {
    const script = join(temp, '脚本 文件.ps1')
    const result = join(temp, 'ps-args.json')
    await fs.writeFile(script,
      "param([string]$Value)\r\n[System.IO.File]::WriteAllText($env:KEVIN_PROBE_OUT, (@($Value, $env:KEVIN_PROBE_ENV) | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))\r\n")
    const value = 'D:\\程序 工作\\'
    const launch = await Launcher.launch({
      targetPath: script, arguments: windowsCommandLine([value]), workingDirectory: temp,
      runAsAdmin: false, environmentVariables: { KEVIN_PROBE_OUT: result, KEVIN_PROBE_ENV: '短 路径 & %' }
    })
    expect(launch).toMatchObject({ ok: true, confirmation: 'requested' })
    await vi.waitFor(async () => {
      expect(JSON.parse(await fs.readFile(result, 'utf8'))).toEqual([value, '短 路径 & %'])
    }, { timeout: DETACHED_PROBE_WAIT_MS })
  }, DETACHED_PROBE_TEST_TIMEOUT_MS)

  it('reports shortcut dispatch as a request and passes escaped argv and environment to the Windows shell', async () => {
    vi.mocked(isElevated).mockResolvedValueOnce(false)
    vi.mocked(runPowerShell).mockResolvedValueOnce('42\n')
    const launch = await Launcher.launch({
      targetPath: "D:\\带空格的'快捷方式.lnk", arguments: windowsCommandLine(['a"b', 'D:\\path with space\\']),
      workingDirectory: 'D:\\工作 目录', runAsAdmin: true,
      environmentVariables: { KL_TEST: "Tom's env" }
    })
    expect(launch).toMatchObject({ ok: true, confirmation: 'requested', pid: null, elevated: true })
    expect(launch.observation.targetExecutable).toBe('D:\\游戏\\game.exe')
    const command = vi.mocked(runPowerShell).mock.calls[0][0]
    expect(command).toContain("'Tom''s env'")
    expect(command).toContain('-Verb RunAs')
    expect(command).toContain(windowsCommandLine(['a"b', 'D:\\path with space\\']))
  })
})
