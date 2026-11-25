import { shell } from 'electron'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { win32 } from 'path'
import type { LaunchResult } from '@shared/types'
import type { LaunchObservation } from './processObservation'
import { log } from './logger'
import { isElevated } from './elevation'
import { psQuote, runPowerShell } from './powershell'
import { splitArgs, windowsCommandLine } from './windowsArguments'

export { splitArgs } from './windowsArguments'

export interface LaunchSpec {
  targetPath: string
  arguments: string
  workingDirectory: string
  runAsAdmin: boolean
  environmentVariables?: Record<string, string>
}

export interface ProcessLaunchResult extends LaunchResult {
  observation: LaunchObservation
}

interface LaunchCommand {
  executable: string
  args: string[]
  env: Record<string, string>
  verbatim?: boolean
  indirect?: boolean
  detached?: boolean
}

type SpawnResult = LaunchResult & { code?: string }

async function identifiedPath(path: string | undefined): Promise<string | undefined> {
  if (!path || !win32.isAbsolute(path)) return undefined
  return fs.realpath(path).catch(() => path)
}

function environment(spec: LaunchSpec): Record<string, string> {
  const values = spec.environmentVariables ?? {}
  if (Object.entries(values).some(([key, value]) =>
    !key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0')
  )) throw new Error('环境变量格式无效')
  return { ...values }
}

function childEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const names = new Set(Object.keys(overrides).map((key) => key.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !names.has(key.toLowerCase()))),
    ...overrides
  }
}

function resolveCommand(spec: LaunchSpec): LaunchCommand {
  const ext = win32.extname(spec.targetPath).toLowerCase()
  const args = splitArgs(spec.arguments)
  const env = environment(spec)
  if (ext === '.bat' || ext === '.cmd') {
    const fields = [spec.targetPath, ...args].map((value, index) => {
      // Expansion happens once. Quoting each value keeps cmd metacharacters literal.
      if (/["\x00-\x1f]/.test(value)) throw new Error('批处理参数不能包含字面双引号或控制字符')
      const key = `KEVIN_LAUNCH_BATCH_ARG_${index}`
      env[key] = value
      return `"%${key}%"`
    })
    return {
      executable: process.env.ComSpec || win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
      args: ['/D', '/V:OFF', '/S', '/C', `"${fields.join(' ')}"`],
      env, verbatim: true, indirect: true
    }
  }
  if (ext === '.ps1') {
    return {
      executable: win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', spec.targetPath, ...args], env, indirect: true,
      // Windows PowerShell can exit successfully without executing -File
      // when its process is started with the detached console flag.
      detached: false
    }
  }
  return { executable: spec.targetPath, args, env, indirect: ext === '.lnk' }
}

function isElevationError(result: SpawnResult): boolean {
  return result.code === 'EACCES' || result.code === 'EPERM' || /elevation|740/i.test(result.error ?? '')
}

/** Keep a distinct observation intent for successful shell requests. */
export class Launcher {
  static async launch(spec: LaunchSpec, name = ''): Promise<ProcessLaunchResult> {
    const observation: LaunchObservation = { requestedAt: Date.now() }
    const failed = (error: unknown): ProcessLaunchResult => ({
      ok: false, pid: null, elevated: false, error: error instanceof Error ? error.message : String(error), observation
    })
    try {
      const command = resolveCommand(spec)
      const cwd = spec.workingDirectory.trim() || win32.dirname(spec.targetPath)
      const shortcut = win32.extname(spec.targetPath).toLowerCase() === '.lnk'
      observation.rootExecutable = shortcut ? undefined : await identifiedPath(command.executable)
      observation.indirect = command.indirect
      if (shortcut) {
        try {
          observation.targetExecutable = await identifiedPath(shell.readShortcutLink(spec.targetPath).target)
        } catch {
          // Shell associations without a local executable may still open successfully.
        }
      }
      const parentElevated = await isElevated()
      const elevated = spec.runAsAdmin && !parentElevated
      observation.requestedAt = Date.now()
      let result = shortcut || elevated
        ? await this.shellLaunch(command, cwd, elevated, shortcut, parentElevated)
        : await this.spawnDetached(command, cwd, parentElevated)
      if (!shortcut && !elevated && !parentElevated && !result.ok && isElevationError(result)) {
        result = await this.shellLaunch(command, cwd, true, false, false)
        if (result.ok && result.confirmation === 'started') result.message = '该程序需要管理员权限，已自动以管理员身份启动'
      }
      observation.spawnedAt = Date.now()
      if (!result.ok) log(`launch: failed for "${name}" (${result.error ?? 'unknown error'})`)
      else log(`launch: "${name}" ${result.confirmation ?? 'accepted'} (pid=${result.pid ?? 'unconfirmed'})`)
      return { ...result, observation }
    } catch (error) {
      return failed(error)
    }
  }

  private static spawnDetached(command: LaunchCommand, cwd: string, elevated: boolean): Promise<SpawnResult> {
    return new Promise((resolve) => {
      const child = spawn(command.executable, command.args, {
        cwd, env: childEnvironment(command.env), detached: command.detached ?? true, stdio: 'ignore',
        windowsHide: false, windowsVerbatimArguments: command.verbatim
      })
      child.once('error', (error: NodeJS.ErrnoException) =>
        resolve({ ok: false, pid: null, elevated, error: error.message, code: error.code }))
      child.once('spawn', () => {
        child.unref()
        resolve({
          ok: true, pid: child.pid ?? null, elevated, confirmation: command.indirect ? 'requested' : 'started'
        })
      })
    })
  }

  private static async shellLaunch(
    command: LaunchCommand, cwd: string, elevate: boolean, shortcut: boolean, parentElevated: boolean
  ): Promise<SpawnResult> {
    const setEnvironment = Object.entries(command.env).map(([key, value]) =>
      `[Environment]::SetEnvironmentVariable(${psQuote(key)}, ${psQuote(value)}, 'Process')`
    )
    const line = command.verbatim ? command.args.join(' ') : windowsCommandLine(command.args)
    const runAs = elevate ? ' -Verb RunAs' : ''
    const argumentsOption = line ? ` -ArgumentList ${psQuote(line)}` : ''
    const statement = `$process = Start-Process -FilePath ${psQuote(command.executable)}` +
      ` -WorkingDirectory ${psQuote(cwd)} -PassThru${runAs}${argumentsOption}; if ($process) { $process.Id }`
    try {
      const output = await runPowerShell(["$ErrorActionPreference = 'Stop'", ...setEnvironment, statement].join('; '),
        { timeout: elevate ? 180_000 : 20_000 })
      const pid = /^\d+$/m.exec(output)?.[0]
      return {
        ok: true, pid: shortcut || !pid ? null : Number(pid), elevated: elevate || parentElevated,
        confirmation: shortcut || command.indirect || !pid ? 'requested' : 'started'
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.split(/\r?\n/).filter(Boolean).at(-1) : String(error)
      return { ok: false, pid: null, elevated: elevate || parentElevated, error: message || 'Windows 启动失败' }
    }
  }
}
