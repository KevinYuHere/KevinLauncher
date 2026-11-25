param(
  [Parameter(Mandatory)][ValidateSet('launch', 'processes', 'close', 'links', 'integration', 'paths', 'seed-old-links')]
  [string]$Action,
  [string]$Target,
  [int]$ProcessId,
  [string]$InstallerName
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP) {
  throw 'Trial installation acceptance requires a disposable GitHub-hosted Windows runner'
}
$layout = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../src/shared/windowsLayout.json') | ConvertFrom-Json
$trialLinks = @('KevinLauncherTrial-Start.lnk', 'KevinLauncherTrial-Desktop.lnk')

if ($Action -eq 'paths') {
  [ordered]@{
    programFiles = [Environment]::GetFolderPath('ProgramFiles')
    userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  } | ConvertTo-Json -Compress
  return
}

if ($Action -eq 'launch') {
  # Use the normal Windows shell verb and no arguments, just as Explorer does.
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $Target
  $start.WorkingDirectory = Split-Path -LiteralPath $Target
  $start.UseShellExecute = $true
  $process = [System.Diagnostics.Process]::Start($start)
  if ($process) { $process.Id } else { 0 }
  return
}

if ($Action -eq 'seed-old-links') {
  $trial = Join-Path $env:LOCALAPPDATA 'KevinLauncherTrial'
  $old = Join-Path $trial 'installed\KevinLauncherTrial'
  $integration = Join-Path $trial 'integration'
  $shell = New-Object -ComObject WScript.Shell
  foreach ($name in $trialLinks) {
    $link = $shell.CreateShortcut((Join-Path $integration $name))
    $link.TargetPath = Join-Path $old $layout.trialEntry
    $link.WorkingDirectory = $old
    $link.Save()
  }
  return
}

if ($Action -eq 'links') {
  $shell = New-Object -ComObject WScript.Shell
  $trialLinks | ForEach-Object {
    $path = Join-Path $Target $_
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing trial shortcut $path" }
    $link = $shell.CreateShortcut($path)
    [pscustomobject]@{ file = $path; target = $link.TargetPath; workingDirectory = $link.WorkingDirectory; arguments = $link.Arguments }
  } | ConvertTo-Json -Compress
  return
}

if ($Action -eq 'integration') {
  function Get-ValueMap($hive, $path, [string[]]$names) {
    $key = $hive.OpenSubKey($path)
    if (-not $key) { return $null }
    try {
      $result = [ordered]@{}
      if (-not $names) { $names = @($key.GetValueNames() | Sort-Object) }
      foreach ($name in $names) { $result[$name] = $key.GetValue($name) }
      return $result
    } finally { $key.Dispose() }
  }
  function Get-FileDigest($file) {
    if (Test-Path -LiteralPath $file -PathType Leaf) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
  }
  $user = [Microsoft.Win32.Registry]::CurrentUser
  $machine = [Microsoft.Win32.Registry]::LocalMachine
  $uninstall = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\KevinLauncher'
  $scheduled = Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object TaskName -EQ KevinLauncher
  $production = Join-Path $env:LOCALAPPDATA 'Programs\KevinLauncher'
  $productionMachine = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'KevinLauncher'
  [ordered]@{
    app = Get-ValueMap $user 'Software\KevinLauncher'
    uninstallUser = Get-ValueMap $user $uninstall
    uninstallMachine = Get-ValueMap $machine $uninstall
    run = Get-ValueMap $user 'Software\Microsoft\Windows\CurrentVersion\Run' @('KevinLauncher', 'KevinLauncherTrial', 'com.kevin.kevinlauncher', 'com.kevin.kevinlauncher.trial')
    autoStart = if ($scheduled) { Export-ScheduledTask -TaskName KevinLauncher -TaskPath '\' }
    userProgram = Test-Path -LiteralPath $production
    userProgramVersion = Get-FileDigest (Join-Path $production 'resources\app-version.txt')
    machineProgram = Test-Path -LiteralPath $productionMachine
    machineProgramVersion = Get-FileDigest (Join-Path $productionMachine 'resources\app-version.txt')
    desktop = Get-FileDigest (Join-Path ([Environment]::GetFolderPath('DesktopDirectory', 'DoNotVerify')) 'KevinLauncher.lnk')
    startMenu = Get-FileDigest (Join-Path ([Environment]::GetFolderPath('Programs', 'DoNotVerify')) 'KevinLauncher.lnk')
  } | ConvertTo-Json -Compress -Depth 6
  return
}

if ($Action -eq 'close') {
  $process = Get-Process -Id $ProcessId
  if ($process.Path -ine $Target -or $process.ProcessName -ine [IO.Path]::GetFileNameWithoutExtension($layout.trialRuntime)) {
    throw 'Refused to close a process outside the observed trial'
  }
  if (-not $process.CloseMainWindow()) { throw 'The trial window could not be closed' }
  return
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class TrialToken {
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int size, out int needed);
    [DllImport("advapi32.dll")]
    static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")]
    static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("advapi32.dll")]
    static extern bool IsTokenRestricted(IntPtr token);

    public static int[] Read(uint processId) {
        IntPtr process = OpenProcess(0x1000, false, processId); // PROCESS_QUERY_LIMITED_INFORMATION
        if (process == IntPtr.Zero) throw new Win32Exception();
        IntPtr token = IntPtr.Zero;
        IntPtr value = IntPtr.Zero;
        try {
            if (!OpenProcessToken(process, 0x8, out token)) throw new Win32Exception(); // TOKEN_QUERY
            int size;
            GetTokenInformation(token, 25, IntPtr.Zero, 0, out size); // TokenIntegrityLevel
            if (size <= 0) throw new Win32Exception();
            value = Marshal.AllocHGlobal(size);
            if (!GetTokenInformation(token, 25, value, size, out size)) throw new Win32Exception();
            IntPtr sid = Marshal.ReadIntPtr(value);
            int level = Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(Marshal.ReadByte(GetSidSubAuthorityCount(sid)) - 1)));
            if (!GetTokenInformation(token, 20, value, 4, out size)) throw new Win32Exception(); // TokenElevation
            int elevated = Marshal.ReadInt32(value);
            if (!GetTokenInformation(token, 29, value, 4, out size)) throw new Win32Exception(); // TokenIsAppContainer
            return new[] { level, elevated, IsTokenRestricted(token) ? 1 : 0, Marshal.ReadInt32(value) };
        } finally {
            Marshal.FreeHGlobal(value);
            if (token != IntPtr.Zero) CloseHandle(token);
            CloseHandle(process);
        }
    }
}
'@

if ($InstallerName -notmatch '^KevinLauncherTrial-Installer-[\w.\-+]+\.exe$') {
  throw 'Expected the trial installer file name'
}
$filter = "Name = '$InstallerName' OR Name = '$($layout.trialEntry)' OR Name = '$($layout.trialRuntime)'"
$running = @(Get-CimInstance Win32_Process -Filter $filter | ForEach-Object {
  $observedId = $_.ProcessId
  try {
    $process = Get-Process -Id $observedId
    $token = [TrialToken]::Read($observedId)
    [ordered]@{
      id = $observedId
      parentId = $_.ParentProcessId
      path = $_.ExecutablePath
      window = $process.MainWindowHandle -ne [IntPtr]::Zero
      renderer = $_.CommandLine -match '(?:^|\s)--type=renderer(?:\s|$)'
      noSandbox = $_.CommandLine -match '(?:^|\s)--no-sandbox(?:\s|$)'
      high = $token[0] -ge 0x3000 -and $token[1] -ne 0
      integrityRid = $token[0]
      restricted = $token[2] -ne 0
      appContainer = $token[3] -ne 0
    }
  } catch {
    # Chromium helper processes can finish between enumeration and token inspection.
    if (Get-Process -Id $observedId -ErrorAction SilentlyContinue) { throw }
  }
})
$runner = [TrialToken]::Read($PID)
[ordered]@{
  runnerIntegrityRid = $runner[0]
  runnerElevated = $runner[1] -ne 0
  processes = $running
} | ConvertTo-Json -Compress -Depth 4
