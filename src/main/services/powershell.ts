import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { promisify } from 'util'
import { win32 } from 'path'

const execFileAsync = promisify(execFile)

export interface PowerShellOptions {
  /** Output cap; defaults to 8 MB (font enumeration lists a lot of names). */
  maxBuffer?: number
  /** Kill a hung command after this many ms. */
  timeout?: number
  signal?: AbortSignal
  /** Use Windows' executable, working directory and modules for privileged helpers. */
  systemOnly?: boolean
}

/**
 * Quote a value for a PowerShell single-quoted string literal.
 * Use this instead of building commands by string concatenation.
 */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Embed a value as data even if it contains PowerShell's typographic quote delimiters. */
export function psDataLiteral(value: string): string {
  const encoded = Buffer.from(value, 'utf8').toString('base64')
  return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`
}

function powerShellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', utf8PowerShell(script)]
}

function utf8PowerShell(script: string): string {
  return `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`
}

function powerShellInvocation(script: string, systemOnly = false) {
  const system = systemOnly ? systemPowerShell() : undefined
  // Windows PowerShell itself may prepend a machine module directory on startup.
  const command = system ? "$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules'); " + script : script
  return {
    executable: system ? win32.join(system.directory, 'powershell.exe') : 'powershell.exe',
    args: powerShellArgs(command),
    options: { windowsHide: true, ...(system ? { cwd: system.directory, env: system.env } : {}) }
  }
}

/**
 * Run a PowerShell script and return its stdout.
 *
 * `[Console]::OutputEncoding` is forced to UTF-8 on purpose: when stdout is
 * redirected, PowerShell otherwise emits text in the OEM code page, which
 * mangles non-ASCII (Chinese) font names, file paths, etc.
 */
export async function runPowerShell(script: string, options: PowerShellOptions = {}): Promise<string> {
  const invocation = powerShellInvocation(script, options.systemOnly)
  const { stdout } = await execFileAsync(
    invocation.executable,
    invocation.args,
    {
      ...invocation.options,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      signal: options.signal,
      ...(options.timeout ? { timeout: options.timeout } : {})
    }
  )
  return stdout
}

/** Synchronous Windows directory discovery and pre-ready data bootstrap. */
export function runPowerShellSync(script: string, options: Pick<PowerShellOptions, 'systemOnly'> = {}): string {
  const invocation = powerShellInvocation(script, options.systemOnly)
  return execFileSync(invocation.executable, invocation.args, {
    ...invocation.options,
    encoding: 'utf8',
    timeout: 5000
  })
}

/** Starts a Windows API helper with a private UTF-8 request/reply pipe. */
export function startPowerShell(script: string): ChildProcessWithoutNullStreams {
  return spawn('powershell.exe', powerShellArgs(script), { windowsHide: true })
}

function systemPowerShell() {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !/^[a-z]:[\\/]/i.test(systemRoot)) throw new Error('无法定位 Windows 系统 PowerShell')
  const system = win32.join(systemRoot, 'System32')
  const directory = win32.join(system, 'WindowsPowerShell', 'v1.0')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|psmodulepath)$/i.test(key)))
  env.Path = `${directory};${system}`
  env.PSModulePath = win32.join(directory, 'Modules')
  return { system, directory, env }
}

/** Run the fixed elevated helper entry with private input/output and an open diagnostics sink. */
export function startPowerShellWithReport(script: string, reportFd: number) {
  const { system, directory, env } = systemPowerShell()
  // libuv's Windows job kills its direct children on exit but lets their
  // children leave the job. PowerShell still needs its normal console flags.
  const entry = Buffer.from(utf8PowerShell(script), 'utf16le').toString('base64')
  return spawn(win32.join(system, 'cmd.exe'), [
    '/d', '/s', '/c', 'powershell.exe', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', entry
  ], {
    cwd: directory, env, windowsHide: true, stdio: ['pipe', 'pipe', reportFd]
  })
}
