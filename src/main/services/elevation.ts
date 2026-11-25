import { psQuote, runPowerShell } from './powershell'
import { log } from './logger'
import { windowsCommandLine } from './windowsArguments'

let cached: Promise<boolean> | null = null
const REQUESTED = '--kevin-elevation-requested'

const PS_CHECK =
  '[bool](([System.Security.Principal.WindowsPrincipal][System.Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator))'

/** Whether the current launcher process runs with administrator rights. */
export function isElevated(): Promise<boolean> {
  return tokenIsElevated().catch(() => false)
}

function tokenIsElevated(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(true)
  cached ??= runPowerShell(PS_CHECK, { timeout: 10_000 }).then(output => {
    const result = output.trim().toLowerCase()
    if (result === 'true') return true
    if (result === 'false') return false
    throw new Error('未能确认当前进程的管理员权限')
  })
  return cached
}

/** Only the process with the elevated token may continue into the packaged UI. */
export async function ensureAdministrator(mode: 'app' | 'install'): Promise<boolean> {
  try {
    if (await tokenIsElevated()) return true
    const args = process.argv.slice(1)
    if (args.includes(REQUESTED)) throw new Error('提权后仍未获得管理员权限')
    // A legacy portable session must restart the outer file. Its extracted
    // executable is removed by NSIS as soon as the original instance exits.
    const file = mode === 'install' ? process.env.PORTABLE_EXECUTABLE_FILE || process.execPath : process.execPath
    const commandLine = windowsCommandLine([...args, REQUESTED])
    await runPowerShell(
      'Start-Process -Verb RunAs -ErrorAction Stop -FilePath ' + psQuote(file) +
      ' -ArgumentList ' + psQuote(commandLine),
      { timeout: 180_000 }
    )
  } catch (error) {
    log(mode + ': administrator startup stopped (' + (error as Error).message + ')')
  }
  return false
}
