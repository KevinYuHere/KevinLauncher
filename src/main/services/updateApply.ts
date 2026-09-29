import { app } from 'electron'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { log } from './logger'

/** Escapes a value for a single-quoted PowerShell string. */
const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`

/**
 * Applies a staged update and restarts the launcher.
 *
 * The running launcher locks its own executable and loaded libraries, so a small
 * detached PowerShell helper waits for this process to exit, copies the staged
 * files over the installation directory and starts the launcher again. The
 * helper inherits the launcher's elevation, so no extra UAC prompt appears.
 */
export async function applyStagedUpdate(stagingDir: string, installDir: string): Promise<void> {
  const executable = join(installDir, 'KevinLauncher.exe')
  const script = join(app.getPath('temp'), `kevin-apply-update-${Date.now()}.ps1`)
  const body = `
$ErrorActionPreference = 'Stop'
$pid0 = ${process.pid}
while (Get-Process -Id $pid0 -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 300 }
Start-Sleep -Milliseconds 500
Copy-Item -Path (Join-Path ${quote(stagingDir)} '*') -Destination ${quote(installDir)} -Recurse -Force
Start-Process -FilePath ${quote(executable)}
Remove-Item -LiteralPath ${quote(stagingDir)} -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
`.trim()

  await fs.writeFile(script, body, 'utf-8')
  log(`appUpdate: applying via ${script}`)
  spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
    { detached: true, stdio: 'ignore', windowsHide: true }
  ).unref()
  app.quit()
}
