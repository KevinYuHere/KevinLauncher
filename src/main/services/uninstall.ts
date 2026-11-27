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
import { canonicalExecutable, hasProcessIdentity, ProcessTree } from './processTree'

export interface DirectoryIdentity {
  volume: string
  file: string
}

export interface UninstallOwner {
  pid: number
  path: string
  required: boolean
  createdAt?: number
}

/** Bind a directory to its Windows volume/file identity and reject redirected paths. */
export async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const requested = resolve(path)
  const link = await fs.lstat(requested, { bigint: true })
  if (!link.isDirectory() || link.isSymbolicLink()) throw new Error('目录必须是未重定向的实体目录：' + path)
  const real = await fs.realpath(requested)
  if (real.toLowerCase() !== requested.toLowerCase()) throw new Error('目录路径包含未知重定向：' + path)
  const stat = await fs.stat(requested, { bigint: true })
  return { volume: (stat.dev & 0xffffffffn).toString(), file: stat.ino.toString() }
}

async function processOwner(pid: number, required: boolean, expectedPath: string): Promise<UninstallOwner | null> {
  const snapshot = await ProcessTree.snapshot().catch(() => null)
  if (!snapshot) throw new Error('无法确认卸载进程身份，未执行卸载')
  const found = snapshot.find((item) => item.pid === pid)
  const expected = canonicalExecutable(expectedPath)
  if (!found || !hasProcessIdentity(found) || canonicalExecutable(found.executable) !== expected) {
    if (required) throw new Error('无法确认卸载进程身份，未执行卸载')
    return null
  }
  return { pid, path: expectedPath, required, createdAt: found.createdAt }
}

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
  backupId?: DirectoryIdentity
  installDirId?: DirectoryIdentity
  installParentId?: DirectoryIdentity
  dataDirId?: DirectoryIdentity
  dataParentId?: DirectoryIdentity
  owners: ReadonlyArray<UninstallOwner>
  files: string[]
  cleanup?: string
}): string {
  const {
    installDir, dataDir, dataBackup, backup, backupId, installDirId, installParentId, dataDirId, dataParentId,
    owners, files, cleanup = ''
  } = input
  if (dataDir && !dataBackup) throw new Error('Missing data quarantine directory')
  const identity = (value: DirectoryIdentity | undefined): string => value
    ? `(ConvertFrom-Json -InputObject ${psDataLiteral(JSON.stringify(value))})`
    : '$null'
  return `
$ErrorActionPreference = 'Stop'
$root = ${psDataLiteral(installDir)}
$backup = ${psDataLiteral(backup)}
$data = ${dataDir ? psDataLiteral(dataDir) : "$null"}
$savedData = ${dataBackup ? psDataLiteral(dataBackup) : "$null"}
$rootId = ${identity(installDirId)}
$rootParentId = ${identity(installParentId)}
$dataId = ${identity(dataDirId)}
$dataParentId = ${identity(dataParentId)}
$backupId = ${identity(backupId)}
$files = ConvertFrom-Json -InputObject ${psDataLiteral(JSON.stringify(files))}
$owners = ConvertFrom-Json -InputObject ${psDataLiteral(JSON.stringify(owners))}
$moved = [System.Collections.Generic.List[string]]::new()
$dirs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$committed = $false
$dataMoved = $false
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class KevinUninstallDirectoryId
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle handle, int infoClass, out FileId info, uint size);

    [StructLayout(LayoutKind.Sequential)]
    public struct FileId
    {
        public ulong VolumeId;
        public ulong FileIdLow;
        public ulong FileIdHigh;
    }

    public static string Read(string path)
    {
        using (SafeFileHandle handle = CreateFile(
            path, 0x80, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero))
        {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            FileId info;
            if (!GetFileInformationByHandleEx(
                    handle, 18, out info, (uint)Marshal.SizeOf(typeof(FileId))))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return info.VolumeId.ToString() + ":" + info.FileIdLow.ToString();
        }
    }
}
'@
function Get-DirectoryId([string]$path) {
  $parts = [KevinUninstallDirectoryId]::Read($path).Split(':')
  return [pscustomobject]@{
    volume = (([uint64]$parts[0]) -band [uint64]4294967295).ToString()
    file = $parts[1]
  }
}
function Assert-Identity([string]$path, $expected, [string]$label) {
  if ($null -eq $expected) { return }
  Assert-PlainPath $path
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if (!$item.PSIsContainer) { throw "$label is not a directory: $path" }
  $actual = Get-DirectoryId $path
  if ([uint64]$actual.volume -ne [uint64]$expected.volume -or
      [uint64]$actual.file -ne [uint64]$expected.file) {
    throw "$label identity changed: $path"
  }
}
function Assert-PlainPath([string]$path) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  while ($item) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Redirected path: $path" }
    if ($item -is [IO.FileInfo]) { $item = $item.Directory } else { $item = $item.Parent }
  }
}
function Remove-Quarantine([string]$path) {
  Assert-PlainPath $path
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
function Remove-KnownQuarantine([string]$path, $expected, [string[]]$relativeFiles) {
  Assert-Identity $path $expected 'Program quarantine'
  foreach ($relative in $relativeFiles) {
    $file = Join-Path $path $relative
    if (!(Test-Path -LiteralPath $file -PathType Leaf -ErrorAction Stop)) { continue }
    Assert-PlainPath $file
    Remove-Item -LiteralPath $file -Force -ErrorAction Stop
  }
  $quarantineDirs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($relative in $relativeFiles) {
    $directory = [IO.Path]::GetDirectoryName((Join-Path $path $relative))
    while ($directory -and $directory -ine $path) {
      [void]$quarantineDirs.Add($directory)
      $directory = [IO.Path]::GetDirectoryName($directory)
    }
  }
  foreach ($dir in @($quarantineDirs | Sort-Object Length -Descending)) {
    if (!(Test-Path -LiteralPath $dir -ErrorAction Stop)) { continue }
    Assert-PlainPath $dir
    if (@(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop).Count -eq 0) {
      [IO.Directory]::Delete($dir)
    }
  }
  Assert-Identity $path $expected 'Program quarantine'
  if (@(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop).Count -eq 0) {
    [IO.Directory]::Delete($path)
  } else {
    throw "Program quarantine contains unverified entries: $path"
  }
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
  Assert-Identity $root $rootId 'Install directory'
  Assert-Identity (Split-Path -Parent $root) $rootParentId 'Install directory parent'
  $epoch = [DateTime]::SpecifyKind([DateTime]'1970-01-01', [DateTimeKind]::Utc)
  $waiting = @()
  foreach ($expected in $owners) {
    $owner = Get-Process -Id $expected.pid -ErrorAction SilentlyContinue
    if ($owner) {
      try {
        $null = $owner.Handle
        if ($owner.HasExited) { throw 'Process exited' }
        $created = [long][Math]::Floor(($owner.StartTime.ToUniversalTime() - $epoch).TotalMilliseconds)
        $sameCreation = ($null -eq $expected.createdAt) -or
          ([Math]::Abs($created - [long]$expected.createdAt) -le 2)
        if ($sameCreation -and $owner.MainModule.FileName -ieq $expected.path) {
          $waiting += $owner
          continue
        }
      } catch { }
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
  Assert-PlainPath $root
  Assert-Identity $root $rootId 'Install directory'
  Assert-Identity (Split-Path -Parent $root) $rootParentId 'Install directory parent'
  if ($null -eq $backupId) {
    if (Test-Path -LiteralPath $backup -ErrorAction Stop) { throw 'Program quarantine already exists' }
    [IO.Directory]::CreateDirectory($backup) | Out-Null
    $backupId = Get-DirectoryId $backup
  } else {
    Assert-Identity $backup $backupId 'Program quarantine'
  }
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
      Assert-Identity $backup $backupId 'Program quarantine'
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
    Assert-Identity $data $dataId 'User data directory'
    Assert-Identity (Split-Path -Parent $data) $dataParentId 'User data directory parent'
    if (Test-Path -LiteralPath $savedData -ErrorAction Stop) { throw 'Data quarantine already exists' }
    Move-Item -LiteralPath $data -Destination $savedData -ErrorAction Stop
    $dataMoved = $true
    Assert-Identity $savedData $dataId 'User data quarantine'
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
    if ($backupId -and (Test-Path -LiteralPath $backup -ErrorAction Stop)) {
      Remove-KnownQuarantine $backup $backupId @($moved)
    }
    if ($savedData -and (Test-Path -LiteralPath $savedData -ErrorAction Stop)) {
      Assert-Identity $savedData $dataId 'User data quarantine'
      Remove-Quarantine $savedData
    }
  }
  [Console]::Error.WriteLine('complete')
} catch {
  $failure = $_.Exception.Message
  if (!$committed) {
    if ($dataMoved) {
      try {
        Assert-Identity $savedData $dataId 'User data quarantine'
        if (Test-Path -LiteralPath $data -ErrorAction Stop) { throw 'Data location is no longer empty' }
        Move-Item -LiteralPath $savedData -Destination $data -ErrorAction Stop
      }
      catch { $failure += "; data rollback: $($_.Exception.Message) ($savedData)" }
    }
    foreach ($relative in $moved) {
      $from = Join-Path $backup $relative
      $to = Join-Path $root $relative
      try {
        Assert-Identity $backup $backupId 'Program quarantine'
        Assert-Identity $root $rootId 'Install directory'
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
  const installDirId = await directoryIdentity(installDir)
  const installParentId = await directoryIdentity(dirname(installDir))
  const dataDir = keepUserData ? undefined : await fs.realpath(options.dataDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (dataDir && (isFileSystemRoot(dataDir) ||
      dataDir.toLowerCase() !== resolve(options.dataDir).toLowerCase() ||
      directoriesOverlap(dataDir, installDir))) throw new Error('用户数据目录已改变，未执行卸载')
  const dataDirId = dataDir ? await directoryIdentity(dataDir) : undefined
  const dataParentId = dataDir ? await directoryIdentity(dirname(dataDir)) : undefined
  onProgress?.('正在等待启动器保存数据并退出…')
  if (!(await closeRunningInstances(installDir))) {
    throw new Error('启动器仍在运行，请先退出再重试卸载')
  }
  // Re-check the identities captured before the wait. A directory replaced by a
  // junction or a different directory must stop the uninstall before any move.
  const afterWait = await directoryIdentity(installDir)
  const parentAfterWait = await directoryIdentity(dirname(installDir))
  if (afterWait.volume !== installDirId.volume || afterWait.file !== installDirId.file ||
      parentAfterWait.volume !== installParentId.volume || parentAfterWait.file !== installParentId.file) {
    throw new Error('安装目录身份已改变，未执行卸载')
  }
  if (dataDir && dataDirId && dataParentId) {
    const dataAfterWait = await directoryIdentity(dataDir)
    const dataParentAfterWait = await directoryIdentity(dirname(dataDir))
    if (dataAfterWait.volume !== dataDirId.volume || dataAfterWait.file !== dataDirId.file ||
        dataParentAfterWait.volume !== dataParentId.volume || dataParentAfterWait.file !== dataParentId.file) {
      throw new Error('用户数据目录身份已改变，未执行卸载')
    }
  }
  const executable = process.execPath
  const self = await processOwner(process.pid, true, executable)
  if (!self) throw new Error('无法确认卸载进程身份，未执行卸载')
  const owners: UninstallOwner[] = [self]
  if (launcherExecutableName !== launcherRuntimeExecutableName &&
      basename(executable).toLowerCase() === launcherRuntimeExecutableName.toLowerCase()) {
    const parent = await processOwner(
      process.ppid, false, join(dirname(executable), launcherExecutableName)
    )
    if (parent) owners.push(parent)
  }
  const id = randomUUID()
  const report = join(app.getPath('temp'), `kevin-uninstall-${id}.result.txt`)
  const backup = join(dirname(installDir), `.kevin-uninstall-${id}`)
  const dataBackup = dataDir && join(dirname(dataDir), `.kevin-uninstall-data-${id}`)
  await fs.mkdir(backup)
  let handedOff = false
  try {
    const backupId = await directoryIdentity(backup)
    const script = uninstallHelperScript({
      installDir, files, dataDir, dataBackup, backup, backupId,
      installDirId, installParentId, dataDirId, dataParentId, owners,
      cleanup: await uninstallIntegrationScript(installDir, dataDir)
    })
    await startUninstallHelper(script, report, () => {
      onProgress?.('正在交接卸载，程序文件移除后将清理系统设置…')
    })
    handedOff = true
  } finally {
    if (!handedOff) {
      // Only an empty, just-created quarantine may be removed here. If the
      // helper already moved something, keep it for inspection/recovery.
      await fs.rmdir(backup).catch((error) => {
        log(`uninstall: retained the quarantine directory ${backup} (${String(error)})`)
      })
    }
  }
  log(`uninstall: handed off to helper. Result: ${report}`)
  return report
}
