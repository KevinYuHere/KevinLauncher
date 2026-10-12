import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface PowerShellOptions {
  /** Output cap; defaults to 8 MB (font enumeration lists a lot of names). */
  maxBuffer?: number
  /** Kill a hung command after this many ms. */
  timeout?: number
}

/**
 * Quote a value for a PowerShell single-quoted string literal.
 * Use this instead of building commands by string concatenation.
 */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Run a PowerShell script and return its stdout.
 *
 * `[Console]::OutputEncoding` is forced to UTF-8 on purpose: when stdout is
 * redirected, PowerShell otherwise emits text in the OEM code page, which
 * mangles non-ASCII (Chinese) font names, file paths, etc.
 */
export async function runPowerShell(script: string, options: PowerShellOptions = {}): Promise<string> {
  const command = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      windowsHide: true,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      ...(options.timeout ? { timeout: options.timeout } : {})
    }
  )
  return stdout
}
