import { app } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join, resolve } from 'path'
import { directoriesOverlap } from '@shared/paths'
import { writeFileAtomic } from './atomicFile'
import { assertTrialInstallDirectory, launcherExecutableName } from './buildIdentity'
import { isFileSystemRoot } from './directoryPath'
import { closeRunningInstances, readInstallInfo, uninstallIntegrationScript } from './install'
import { log } from './logger'
import { psQuote, startDetachedPowerShellFile } from './powershell'

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
  report: string
  ready: string
  commit: string
  files: string[]
  cleanup?: string
}): string {
  const { installDir, dataDir, dataBackup, backup, report, ready, commit, files, cleanup = '' } = input
  if (dataDir && !dataBackup) throw new Error('Missing data quarantine directory')
  return `
param([switch]$ResumeCleanup)
$ErrorActionPreference = 'Stop'
$root = ${psQuote(installDir)}
$backup = ${psQuote(backup)}
$report = ${psQuote(report)}
$ack = ${psQuote(ready)}
$permission = ${psQuote(commit)}
$cleanupReady = $permission + '.cleanup'
$data = ${dataDir ? psQuote(dataDir) : "$null"}
$savedData = ${dataBackup ? psQuote(dataBackup) : "$null"}
$files = @(${files.map(psQuote).join(',\n')})
$moved = [System.Collections.Generic.List[string]]::new()
$dirs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$gone = $false
$dataMoved = $false
$ownScript = $MyInvocation.MyCommand.Path
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
try {
  if ($ResumeCleanup) {
    if (!(Test-Path -LiteralPath $cleanupReady) -or [IO.File]::ReadAllText($cleanupReady) -ne 'cleanup') {
      throw 'Uninstall cleanup was not committed'
    }
    $gone = $true
  } else {
    Assert-PlainPath $root
    [IO.File]::WriteAllText($ack, 'ready', [Text.Encoding]::UTF8)
    $owner = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue
    if ($owner -and $owner.Path -ieq (Join-Path $root ${psQuote(launcherExecutableName)})) {
      if (!$owner.WaitForExit(30000)) { throw 'Uninstaller did not exit' }
    }
    if (!(Test-Path -LiteralPath $permission) -or [IO.File]::ReadAllText($permission) -ne 'commit') {
      throw 'Uninstall handoff was not confirmed'
    }
    if (Test-Path -LiteralPath $backup -ErrorAction Stop) { throw 'Program quarantine already exists' }
    [IO.Directory]::CreateDirectory($backup) | Out-Null
  }
  foreach ($relative in $files) {
    $file = Join-Path $root $relative
    if (!$gone -and (Test-Path -LiteralPath $file -ErrorAction Stop)) {
      Assert-PlainPath $file
      if (!(Test-Path -LiteralPath $file -PathType Leaf -ErrorAction Stop)) { throw "Expected file: $file" }
      $saved = Join-Path $backup $relative
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($saved)) | Out-Null
      Move-Item -LiteralPath $file -Destination $saved -ErrorAction Stop
      $moved.Add($relative)
    }
    $directory = [IO.Path]::GetDirectoryName($file)
    while ($directory -ine $root) {
      [void]$dirs.Add($directory)
      $directory = [IO.Path]::GetDirectoryName($directory)
    }
  }
  if (!$gone) {
    if ($data -and (Test-Path -LiteralPath $data -ErrorAction Stop)) {
      Assert-PlainPath $data
      if (Test-Path -LiteralPath $savedData -ErrorAction Stop) { throw 'Data quarantine already exists' }
      Move-Item -LiteralPath $data -Destination $savedData -ErrorAction Stop
      $dataMoved = $true
    }
    [IO.File]::WriteAllText($cleanupReady, 'cleanup', [Text.Encoding]::UTF8)
    $gone = $true
  }
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
  ${cleanup}
  [IO.File]::WriteAllText($report, 'complete', [Text.Encoding]::UTF8)
  Remove-Item -LiteralPath $cleanupReady -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $ownScript -Force -ErrorAction SilentlyContinue
} catch {
  $failure = $_.Exception.Message
  if (!$gone) {
    if ($dataMoved) {
      try { Move-Item -LiteralPath $savedData -Destination $data -ErrorAction Stop }
      catch { $failure += "; data rollback: $($_.Exception.Message) ($savedData)" }
    }
    foreach ($relative in $moved) {
      $from = Join-Path $backup $relative
      $to = Join-Path $root $relative
      try { Move-Item -LiteralPath $from -Destination $to -ErrorAction Stop }
      catch { $failure += "; rollback: $($_.Exception.Message)" }
    }
    [IO.File]::WriteAllText($report, "failed: $failure; recovery: $backup", [Text.Encoding]::UTF8)
    if (!$ResumeCleanup) { Remove-Item -LiteralPath $ownScript -Force -ErrorAction SilentlyContinue }
  } else {
    [IO.File]::WriteAllText($report, "cleanup pending: $failure; rerun $ownScript with -ResumeCleanup", [Text.Encoding]::UTF8)
  }
  exit 1
} finally {
  Remove-Item -LiteralPath $permission -Force -ErrorAction SilentlyContinue
}
`.trim()
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
  const temp = join(app.getPath('temp'), `kevin-uninstall-${id}`)
  const script = temp + '.ps1'
  const report = temp + '.result.txt'
  const ready = temp + '.ready'
  const commit = temp + '.commit'
  const backup = join(dirname(installDir), `.kevin-uninstall-${id}`)
  const dataBackup = dataDir && join(dirname(dataDir), `.kevin-uninstall-data-${id}`)
  await writeFileAtomic(script, '\uFEFF' + uninstallHelperScript({
    installDir, files, dataDir, dataBackup, backup, report, ready, commit,
    cleanup: uninstallIntegrationScript(installDir, dataDir)
  }))
  try {
    await startDetachedPowerShellFile(script)
    for (let attempt = 0; attempt < 40; attempt++) {
      const confirmed = await fs.readFile(ready, 'utf8').catch(() => '')
      if (confirmed.replace(/^\uFEFF/, '') === 'ready') {
        await fs.rm(ready, { force: true })
        onProgress?.('正在交接卸载，程序文件移除后将清理系统设置…')
        await writeFileAtomic(commit, 'commit')
        log(`uninstall: handed off to helper. Result: ${report}`)
        return report
      }
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    // The helper only works after the calling process exits. Leave this
    // window open if startup cannot be confirmed.
    throw new Error('卸载辅助程序未启动。诊断文件：' + report)
  } catch (error) {
    await fs.rm(script, { force: true }).catch(() => undefined)
    throw error
  }
}
