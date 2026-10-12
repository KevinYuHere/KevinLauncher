import { runPowerShell } from './powershell'

let cached: Promise<boolean> | null = null

const PS_CHECK =
  '[bool](([System.Security.Principal.WindowsPrincipal][System.Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator))'

/** Whether the current launcher process runs with administrator rights. */
export function isElevated(): Promise<boolean> {
  if (!cached) cached = detect()
  return cached
}

async function detect(): Promise<boolean> {
  if (process.platform !== 'win32') return true
  try {
    const stdout = await runPowerShell(PS_CHECK, { timeout: 10_000 })
    return stdout.trim().toLowerCase() === 'true'
  } catch {
    return false
  }
}
