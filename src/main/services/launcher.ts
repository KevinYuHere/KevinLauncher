import { spawn } from 'child_process'
import { dirname, extname } from 'path'
import type { LaunchResult } from '@shared/types'
import { log } from './logger'
import { isElevated } from './elevation'

/** Parse a raw argument string into an argv array, honouring quotes. */
export function splitArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let quoted = false

  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      quoted = true
    } else if (ch === ' ' || ch === '\t') {
      if (quoted || current.length) {
        args.push(current)
        current = ''
        quoted = false
      }
    } else {
      current += ch
    }
  }
  if (quoted || current.length) args.push(current)
  return args
}

/** Quote a string for a PowerShell single-quoted literal. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Everything needed to start a process. Built from a launch method (per app) or
 * a linked launch (starts several apps), so the launcher stays agnostic.
 */
export interface LaunchSpec {
  /** File to start (.exe / .bat / .cmd / .ps1 / .lnk / any file). */
  targetPath: string
  arguments: string
  workingDirectory: string
  runAsAdmin: boolean
  /** Extra environment variables merged over the current process env. */
  environmentVariables?: Record<string, string>
}

type SpawnResult = LaunchResult & { code?: string }

function isElevationError(result: SpawnResult): boolean {
  return (
    result.code === 'EACCES' ||
    result.code === 'EPERM' ||
    /EACCES|EPERM|elevation|740/i.test(result.error ?? '')
  )
}

export class Launcher {
  /**
   * Start `spec.targetPath`. Works for a bare game exe, a `.bat`/`.cmd`
   * script, a `.ps1` script, a `.lnk` shortcut or any other launcher.
   *
   * `.lnk` shortcuts are opened through the shell exactly like double-clicking
   * them (so their target / arguments / working dir / run-as-admin flag are
   * whatever the shortcut says, and stay correct even if the shortcut is
   * updated). Those launches cannot be tracked by pid, so run-state and
   * play-time rely on the entry's `monitorProcessNames`.
   *
   * `name` is only used for logs / user-facing messages.
   */
  static async launch(spec: LaunchSpec, name = ''): Promise<LaunchResult> {
    if (spec.targetPath.toLowerCase().endsWith('.lnk')) {
      return this.spawnShortcut(spec)
    }

    // If the launcher itself is already elevated, a direct spawn of an
    // elevation-required target works and yields a real pid (needed for
    // process-tree tracking and stopping). Only shell out to RunAs when the
    // launcher is not elevated.
    const alreadyElevated = await isElevated()
    if (spec.runAsAdmin && !alreadyElevated) return this.launchElevated(spec)

    const result = await this.spawnDetached(spec)
    if (result.ok) return result

    if (isElevationError(result) && !alreadyElevated) {
      log(`launch: "${name}" requires elevation, retrying as admin`)
      const elevated = await this.launchElevated(spec)
      if (elevated.ok) {
        return { ...elevated, message: '该程序需要管理员权限，已自动以管理员身份启动' }
      }
      return elevated
    }

    log(`launch: failed for "${name}": ${result.error}`)
    return result
  }

  private static resolveCwd(spec: LaunchSpec): string {
    return spec.workingDirectory.trim() || dirname(spec.targetPath)
  }

  /** Open a `.lnk` through the shell (`start`), like a double-click. */
  private static async spawnShortcut(spec: LaunchSpec): Promise<SpawnResult> {
    const cwd = this.resolveCwd(spec)
    const userArgs = splitArgs(spec.arguments)
    const args = ['/c', 'start', '', spec.targetPath, ...userArgs]

    log(`launch: open shortcut "${spec.targetPath}"`)

    return new Promise<SpawnResult>((resolve) => {
      try {
        const child = spawn(process.env.ComSpec || 'cmd.exe', args, {
          cwd,
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        })
        child.once('error', (err: NodeJS.ErrnoException) =>
          resolve({ ok: false, pid: null, elevated: false, error: err.message, code: err.code })
        )
        child.once('spawn', () => {
          log(`launch: shortcut opened`)
          child.unref()
          resolve({ ok: true, pid: null, elevated: false })
        })
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        resolve({ ok: false, pid: null, elevated: false, error: e.message, code: e.code })
      }
    })
  }

  private static async spawnDetached(spec: LaunchSpec): Promise<SpawnResult> {
    const env = { ...process.env, ...spec.environmentVariables }
    const cwd = this.resolveCwd(spec)
    const { command, args } = this.resolveCommand(spec)

    log(`launch: spawn "${command}" ${JSON.stringify(args)} (cwd=${cwd})`)

    return new Promise<SpawnResult>((resolve) => {
      try {
        const child = spawn(command, args, {
          cwd,
          env,
          detached: true,
          stdio: 'ignore',
          windowsHide: false
        })
        child.once('error', (err: NodeJS.ErrnoException) =>
          resolve({ ok: false, pid: null, elevated: false, error: err.message, code: err.code })
        )
        child.once('spawn', () => {
          log(`launch: spawned pid=${child.pid}`)
          child.unref()
          resolve({ ok: true, pid: child.pid ?? null, elevated: false })
        })
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        resolve({ ok: false, pid: null, elevated: false, error: e.message, code: e.code })
      }
    })
  }

  /**
   * Elevated launch through `Start-Process -Verb RunAs`. The elevated process
   * cannot be tracked by pid, so the caller should rely on process-name
   * monitoring for such entries.
   */
  private static async launchElevated(spec: LaunchSpec): Promise<LaunchResult> {
    const { command, args } = this.resolveCommand(spec)
    const cwd = this.resolveCwd(spec)

    let script = `Start-Process -FilePath ${psQuote(command)}`
    if (args.length) script += ` -ArgumentList @(${args.map(psQuote).join(',')})`
    script += ` -WorkingDirectory ${psQuote(cwd)} -Verb RunAs`

    log(`launch: elevated Start-Process "${command}"`)

    return new Promise<LaunchResult>((resolve) => {
      try {
        const child = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
        )
        let stderr = ''
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        child.once('error', (err) =>
          resolve({ ok: false, pid: null, elevated: true, error: err.message })
        )
        child.once('close', (code) => {
          if (code === 0) {
            resolve({ ok: true, pid: null, elevated: true })
          } else {
            const message = stderr.trim().split(/\r?\n/).pop() || `提权启动失败（退出码 ${code}）`
            log(`launch: elevated failed: ${message}`)
            resolve({ ok: false, pid: null, elevated: true, error: message })
          }
        })
      } catch (err) {
        resolve({ ok: false, pid: null, elevated: true, error: (err as Error).message })
      }
    })
  }

  private static resolveCommand(spec: LaunchSpec): { command: string; args: string[] } {
    const ext = extname(spec.targetPath).toLowerCase()
    const userArgs = splitArgs(spec.arguments)

    if (ext === '.bat' || ext === '.cmd') {
      return {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/c', spec.targetPath, ...userArgs]
      }
    }
    if (ext === '.ps1') {
      return {
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', spec.targetPath, ...userArgs]
      }
    }
    return { command: spec.targetPath, args: userArgs }
  }
}
