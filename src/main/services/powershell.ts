import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { promisify } from 'util'
import { once } from 'events'
import { dirname } from 'path'

const execFileAsync = promisify(execFile)

export interface PowerShellOptions {
  /** Output cap; defaults to 8 MB (font enumeration lists a lot of names). */
  maxBuffer?: number
  /** Kill a hung command after this many ms. */
  timeout?: number
  signal?: AbortSignal
}

/**
 * Quote a value for a PowerShell single-quoted string literal.
 * Use this instead of building commands by string concatenation.
 */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function powerShellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`]
}

/**
 * Run a PowerShell script and return its stdout.
 *
 * `[Console]::OutputEncoding` is forced to UTF-8 on purpose: when stdout is
 * redirected, PowerShell otherwise emits text in the OEM code page, which
 * mangles non-ASCII (Chinese) font names, file paths, etc.
 */
export async function runPowerShell(script: string, options: PowerShellOptions = {}): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    powerShellArgs(script),
    {
      windowsHide: true,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      signal: options.signal,
      ...(options.timeout ? { timeout: options.timeout } : {})
    }
  )
  return stdout
}

/** Reserved for data-directory bootstrap, before Electron becomes ready. */
export function runPowerShellSync(script: string): string {
  return execFileSync('powershell.exe', powerShellArgs(script), {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 5000
  })
}

/** Starts a Windows API helper with a private UTF-8 request/reply pipe. */
export function startPowerShell(script: string): ChildProcessWithoutNullStreams {
  return spawn('powershell.exe', powerShellArgs(script), { windowsHide: true })
}

function fileArguments(file: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]
}

export async function runPowerShellFile(file: string, timeout: number, args: string[] = []): Promise<string> {
  return (await execFileAsync('powershell.exe', [...fileArguments(file), ...args], { windowsHide: true, timeout })).stdout
}

export async function startDetachedPowerShellFile(file: string): Promise<void> {
  const child = spawn('powershell.exe', fileArguments(file), {
    cwd: dirname(file), windowsHide: true, stdio: 'ignore'
  })
  await once(child, 'spawn')
  child.unref()
}
