import { app } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { createInterface } from 'readline'
import { directoriesOverlap } from '@shared/paths'
import { assertTrialInstallDirectory, launcherExecutableName, launcherRuntimeExecutableName } from './buildIdentity'
import { isFileSystemRoot } from './directoryPath'
import { closeRunningInstances, readInstallInfo, uninstallIntegrationScript } from './install'
import { log } from './logger'
import { psDataLiteral, startPowerShellWithReport } from './powershell'

export function managedUninstallPaths(files: unknown[]): string[] {
  const found = new Set<string>()
  const managed: string[] = []
  for (const file of [...files, 'install.json']) {
    if (typeof file !== 'string' || file.split('/').some(part =>
      !part || part === '.' || part === '..' || /[<>:"\\|?*\x00-\x1f]|[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )) throw new Error('安装文件清单存在无效路径，未执行卸载')
    const normalized = file.toLowerCase()
    if (!found.has(normalized)) managed.push(file)
    found.add(normalized)
  }
  if (!found.has(launcherExecutableName.toLowerCase())) throw new Error('安装文件清单缺少程序入口')
  return managed
}

export async function getUninstallDirectory(): Promise<string> {
  const folder = await fs.realpath(dirname(process.execPath))
  if (isFileSystemRoot(folder)) throw new Error('无法从磁盘根目录卸载启动器')
  assertTrialInstallDirectory(folder)
  if (!(await readInstallInfo(folder))) throw new Error('找不到当前启动器的安装记录')
  return folder
}

export function uninstallHelperScript(input: {
  installDir: string
  dataDir: string | undefined
  dataBackup?: string
  backup: string
  owners: ReadonlyArray<{ pid: number; path: string; required: boolean }>
  files: string[]
  cleanup?: string
}): string {
  const { installDir, dataDir, dataBackup, backup, owners, files, cleanup = '' } = input
  if (dataDir && !dataBackup) throw new Error('Missing data quarantine directory')
  return `
$ErrorActionPreference = 'Stop'
$root = ${psDataLiteral(installDir)}
$backup = ${psDataLiteral(backup)}
$data = ${dataDir ? psDataLiteral(dataDir) : "$null"}
$savedData = ${dataBackup ? psDataLiteral(dataBackup) : "$null"}
$files = ConvertFrom-Json -InputObject ${psDataLiteral(JSON.stringify(files))}
$owners = ConvertFrom-Json -InputObject ${psDataLiteral(JSON.stringify(owners))}
$moved = [System.Collections.Generic.List[string]]::new()
$dirs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$committed = $false
$dataMoved = $false
function Assert-PlainPath([string]$path) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  while ($item) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Redirected path: $path" }
    if ($item -is [IO.FileInfo]) { $item = $item.Directory } else { $item = $item.Parent }
  }
}
function Remove-Quarantine([string]$path) {
  foreach ($item in Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop) {
    if (!$item.PSIsContainer) {
      Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop
    } elseif ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      [IO.Directory]::Delete($item.FullName)
    } else {
      Remove-Quarantine $item.FullName
    }
  }
  [IO.Directory]::Delete($path)
}
function Invoke-Cleanup([scriptblock]$operation) {
  for ($attempt = 0; ; $attempt++) {
    try { & $operation; return }
    catch {
      if ($attempt -ge 3) { throw }
      Start-Sleep -Milliseconds (250 * ($attempt + 1))
    }
  }
}
try {
  Assert-PlainPath $root
  $waiting = @()
  foreach ($expected in $owners) {
    $owner = Get-Process -Id $expected.pid -ErrorAction SilentlyContinue
    if ($owner) {
      $null = $owner.Handle
      if ($owner.Path -ieq $expected.path) {
        $waiting += $owner
        continue
      }
      $owner.Dispose()
    }
    if ($expected.required) { throw 'Uninstaller process could not be verified' }
  }
  [Console]::WriteLine('ready')
  if ([Console]::ReadLine() -cne 'commit') { throw 'Uninstall handoff was not confirmed' }
  [Console]::WriteLine('accepted')
  foreach ($process in $waiting) {
    if (!$process.WaitForExit(30000)) { throw 'Uninstaller or its launcher entry did not exit' }
    $process.Dispose()
  }
  Assert-PlainPath (Split-Path -Parent $backup)
  if (Test-Path -LiteralPath $backup -ErrorAction Stop) { throw 'Program quarantine already exists' }
  [IO.Directory]::CreateDirectory($backup) | Out-Null
  Assert-PlainPath $backup
  foreach ($relative in $files) {
    $file = Join-Path $root $relative
    if (Test-Path -LiteralPath $file -ErrorAction Stop) {
      Assert-PlainPath $file
      if (!(Test-Path -LiteralPath $file -PathType Leaf -ErrorAction Stop)) { throw "Expected file: $file" }
      $saved = Join-Path $backup $relative
      $savedParent = [IO.Path]::GetDirectoryName($saved)
      [IO.Directory]::CreateDirectory($savedParent) | Out-Null
      Assert-PlainPath $savedParent
      if (Test-Path -LiteralPath $saved -ErrorAction Stop) { throw "Quarantine file already exists: $saved" }
      Move-Item -LiteralPath $file -Destination $saved -ErrorAction Stop
      $moved.Add($relative)
    }
    $directory = [IO.Path]::GetDirectoryName($file)
    while ($directory -ine $root) {
      [void]$dirs.Add($directory)
      $directory = [IO.Path]::GetDirectoryName($directory)
    }
  }
  if ($data -and (Test-Path -LiteralPath $data -ErrorAction Stop)) {
    Assert-PlainPath $data
    if (Test-Path -LiteralPath $savedData -ErrorAction Stop) { throw 'Data quarantine already exists' }
    Move-Item -LiteralPath $data -Destination $savedData -ErrorAction Stop
    $dataMoved = $true
  }
  Invoke-Cleanup {
    ${cleanup}
  }
  $committed = $true
  Invoke-Cleanup {
    foreach ($dir in @($dirs | Sort-Object Length -Descending) + @($root)) {
      if (!(Test-Path -LiteralPath $dir -ErrorAction Stop)) { continue }
      Assert-PlainPath $dir
      if (@(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop).Count -eq 0) { [IO.Directory]::Delete($dir) }
    }
    foreach ($directory in @($backup, $savedData)) {
      if ($directory -and (Test-Path -LiteralPath $directory -ErrorAction Stop)) {
        Assert-PlainPath $directory
        Remove-Quarantine $directory
      }
    }
  }
  [Console]::Error.WriteLine('complete')
} catch {
  $failure = $_.Exception.Message
  if (!$committed) {
    if ($dataMoved) {
      try {
        Assert-PlainPath $savedData
        if (Test-Path -LiteralPath $data -ErrorAction Stop) { throw 'Data location is no longer empty' }
        Move-Item -LiteralPath $savedData -Destination $data -ErrorAction Stop
      }
      catch { $failure += "; data rollback: $($_.Exception.Message) ($savedData)" }
    }
    foreach ($relative in $moved) {
      $from = Join-Path $backup $relative
      $to = Join-Path $root $relative
      try {
        Assert-PlainPath $from
        Assert-PlainPath (Split-Path -Parent $to)
        if (Test-Path -LiteralPath $to -ErrorAction Stop) { throw "File location is no longer empty: $to" }
        Move-Item -LiteralPath $from -Destination $to -ErrorAction Stop
      }
      catch { $failure += "; rollback: $($_.Exception.Message)" }
    }
    [Console]::Error.WriteLine("failed: $failure; recovery: $backup; retry using the installed launcher")
  } else {
    [Console]::Error.WriteLine("cleanup pending: $failure; quarantine: $backup $savedData")
  }
  exit 1
}
`.trim()
}

const HELPER_ENTRY = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.Encoding]::UTF8
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$line = [Console]::ReadLine()
if ($null -eq $line) { exit 1 }
$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
& ([scriptblock]::Create($body)) | Out-Null
`.trim()

/** The report is a write-only inherited handle. Only the anonymous pipe can authorize removal. */
export async function startUninstallHelper(script: string, report: string, ready?: () => void): Promise<void> {
  const diagnostics = await fs.open(report, 'wx')
  try {
    const child = startPowerShellWithReport(HELPER_ENTRY, diagnostics.fd)
    const { stdin, stdout } = child
    if (!stdin || !stdout) {
      child.kill()
      throw new Error('卸载辅助程序缺少交接管道')
    }
    const lines = createInterface({ input: stdout })
    let commitSent = false
    await new Promise<void>((resolveHandoff, reject) => {
      let finished = false
      const finish = (error?: Error): void => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        lines.close()
        stdout.destroy()
        if (error) {
          stdin.destroy()
          if (!commitSent) child.kill()
          reject(error)
        } else {
          child.unref()
          resolveHandoff()
        }
      }
      const timeout = setTimeout(() => finish(new Error('卸载辅助程序未就绪，诊断文件：' + report)), 10_000)
      child.once('error', finish)
      child.once('close', () => finish(new Error('卸载辅助程序提前退出，诊断文件：' + report)))
      stdin.once('error', finish)
      stdout.once('error', finish)
      lines.on('line', (line) => {
        if (line === 'ready' && !commitSent) {
          try {
            ready?.()
            commitSent = true
            stdin.end('commit\n')
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
          }
        } else if (line === 'accepted' && commitSent) finish()
      })
      stdin.write(Buffer.from(script, 'utf8').toString('base64') + '\n')
    })
  } finally {
    await diagnostics.close()
  }
}

export async function prepareUninstall(options: {
  installDir: string
  dataDir: string
  keepUserData: boolean
  onProgress?: (step: string) => void
}): Promise<string> {
  const { installDir, keepUserData, onProgress } = options
  if ((await getUninstallDirectory()).toLowerCase() !== installDir.toLowerCase()) {
    throw new Error('安装目录已改变，未执行卸载')
  }
  const installed = await readInstallInfo(installDir)
  if (!installed) throw new Error('找不到当前启动器的安装记录')
  const files = managedUninstallPaths(installed.files)
  const dataDir = keepUserData ? undefined : await fs.realpath(options.dataDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (dataDir && (isFileSystemRoot(dataDir) ||
      dataDir.toLowerCase() !== resolve(options.dataDir).toLowerCase() ||
      directoriesOverlap(dataDir, installDir))) throw new Error('用户数据目录已改变，未执行卸载')
  onProgress?.('正在等待启动器保存数据并退出…')
  if (!(await closeRunningInstances(installDir))) {
    throw new Error('启动器仍在运行，请先退出再重试卸载')
  }
  const id = randomUUID()
  const report = join(app.getPath('temp'), `kevin-uninstall-${id}.result.txt`)
  const backup = join(dirname(installDir), `.kevin-uninstall-${id}`)
  const dataBackup = dataDir && join(dirname(dataDir), `.kevin-uninstall-data-${id}`)
  const executable = process.execPath
  const owners = [{ pid: process.pid, path: executable, required: true }]
  if (launcherExecutableName !== launcherRuntimeExecutableName &&
      basename(executable).toLowerCase() === launcherRuntimeExecutableName.toLowerCase()) {
    owners.push({ pid: process.ppid, path: join(dirname(executable), launcherExecutableName), required: false })
  }
  const script = uninstallHelperScript({
    installDir, files, dataDir, dataBackup, backup, owners,
    cleanup: uninstallIntegrationScript(installDir, dataDir)
  })
  await startUninstallHelper(script, report, () => {
    onProgress?.('正在交接卸载，程序文件移除后将清理系统设置…')
  })
  log(`uninstall: handed off to helper. Result: ${report}`)
  return report
}
