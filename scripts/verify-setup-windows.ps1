param(
  [Parameter(Mandatory)][ValidateSet('choose-folder', 'links', 'integration', 'launch', 'processes', 'close', 'volumes')]
  [string]$Action,
  [string]$Target,
  [int]$ProcessId
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP) {
  throw 'Windows setup acceptance requires a disposable GitHub-hosted Windows runner'
}
$layout = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../src/shared/windowsLayout.json') | ConvertFrom-Json

if ($Action -eq 'volumes') {
  $volumes = @([IO.DriveInfo]::GetDrives() | Where-Object {
    $_.DriveType -eq 'Fixed' -and $_.IsReady -and $_.DriveFormat -eq 'NTFS' -and $_.AvailableFreeSpace -ge 2GB
  } | ForEach-Object { $_.RootDirectory.FullName })
  ConvertTo-Json -InputObject $volumes -Compress
  return
}

if ($Action -eq 'choose-folder') {
  $entry = @(Get-CimInstance Win32_Process -Filter "Name = '$($layout.entry)' AND ParentProcessId = $ProcessId")
  if ($entry.Count -ne 1) { throw 'Could not identify the public entry inside the portable installer' }
  $entryId = $entry[0].ProcessId
  $runtime = @(Get-CimInstance Win32_Process -Filter "Name = '$($layout.runtime)' AND ParentProcessId = $entryId")
  if ($runtime.Count -ne 1 -or -not (Test-Path -LiteralPath $Target -PathType Container)) {
    throw 'Expected the observed installer runtime and an existing fixture folder'
  }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SetupFolderPicker {
    delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)]
    struct Rectangle { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")]
    static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")]
    static extern bool EnumChildWindows(IntPtr window, WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")]
    static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")]
    static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr window, out Rectangle rect);
    [DllImport("user32.dll")]
    static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, string lParam,
        uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr ReadText(IntPtr window, uint message, IntPtr wParam, StringBuilder lParam,
        uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    static string ClassName(IntPtr window) {
        var text = new StringBuilder(128);
        GetClassName(window, text, text.Capacity);
        return text.ToString();
    }
    static List<IntPtr> Children(IntPtr window) {
        var children = new List<IntPtr>();
        EnumChildWindows(window, (child, _) => { children.Add(child); return true; }, IntPtr.Zero);
        return children;
    }
    static void Confirm(IntPtr dialog, IntPtr button) {
        Rectangle rect;
        if (GetForegroundWindow() == dialog && GetWindowRect(button, out rect) &&
            SetCursorPos((rect.Left + rect.Right) / 2, (rect.Top + rect.Bottom) / 2) && GetForegroundWindow() == dialog) {
            mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); // MOUSEEVENTF_LEFTDOWN
            mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); // MOUSEEVENTF_LEFTUP
            return;
        }
        if (!PostMessage(GetParent(button), 0x0111, new IntPtr(1), button)) throw new Win32Exception(); // WM_COMMAND / IDOK
    }
    static bool WaitForClose(IntPtr dialog, int timeout) {
        DateTime expires = DateTime.UtcNow.AddMilliseconds(timeout);
        while (IsWindowVisible(dialog) && DateTime.UtcNow < expires) Thread.Sleep(150);
        return !IsWindowVisible(dialog);
    }
    static bool Choose(IntPtr dialog, IntPtr input, IntPtr confirm, string directory) {
        IntPtr result;
        if (SendMessageTimeout(input, 0x000C, IntPtr.Zero, directory, 2, 2000, out result) == IntPtr.Zero ||
            result == IntPtr.Zero) throw new Win32Exception(); // WM_SETTEXT
        Confirm(dialog, confirm);
        // Some Shell versions navigate into the typed folder before selecting it.
        DateTime expires = DateTime.UtcNow.AddSeconds(4);
        while (IsWindowVisible(dialog) && DateTime.UtcNow < expires) {
            Thread.Sleep(150);
            var text = new StringBuilder(1024);
            if (ReadText(input, 0x000D, new IntPtr(text.Capacity), text, 2, 500, out result) == IntPtr.Zero) continue; // WM_GETTEXT
            if (string.Equals(text.ToString(), Path.GetFileName(directory), StringComparison.OrdinalIgnoreCase)) {
                Thread.Sleep(300);
                if (IsWindowVisible(dialog)) Confirm(dialog, confirm);
                break;
            }
        }
        if (WaitForClose(dialog, 2000)) return true;
        // A hosted desktop can expose the modal but decline synthetic confirmation.
        if (!PostMessage(dialog, 0x0010, IntPtr.Zero, IntPtr.Zero) || !WaitForClose(dialog, 2000)) // WM_CLOSE
            throw new InvalidOperationException("The native folder picker could not be dismissed");
        return false;
    }
    public static bool Select(uint processId, string directory) {
        DateTime expires = DateTime.UtcNow.AddSeconds(12);
        var observed = new List<string>();
        do {
            IntPtr dialog = IntPtr.Zero;
            EnumWindows((window, _) => {
                uint owner;
                GetWindowThreadProcessId(window, out owner);
                if (owner != processId || !IsWindowVisible(window) || ClassName(window) != "#32770") return true;
                dialog = window;
                return false;
            }, IntPtr.Zero);
            if (dialog != IntPtr.Zero) {
                List<IntPtr> controls = Children(dialog);
                IntPtr confirm = controls.Find(window => GetDlgCtrlID(window) == 1 &&
                    ClassName(window) == "Button" && IsWindowVisible(window) && IsWindowEnabled(window));
                IntPtr input = controls.Find(window => GetDlgCtrlID(window) == 1152 &&
                    ClassName(window) == "Edit" && IsWindowVisible(window));
                if (input == IntPtr.Zero) {
                    IntPtr folderField = controls.Find(window => GetDlgCtrlID(window) == 1148 && IsWindowVisible(window));
                    if (folderField != IntPtr.Zero) input = Children(folderField).Find(window =>
                        ClassName(window) == "Edit" && IsWindowVisible(window));
                }
                if (input != IntPtr.Zero && confirm != IntPtr.Zero) {
                    return Choose(dialog, input, confirm, directory);
                }
                observed = controls.FindAll(IsWindowVisible).ConvertAll(window => ClassName(window) + ":" + GetDlgCtrlID(window));
            }
            Thread.Sleep(200);
        } while (DateTime.UtcNow < expires);
        throw new InvalidOperationException("Native folder picker controls not found. Visible classes: " + string.Join(", ", observed));
    }
}
'@
  [SetupFolderPicker]::Select([uint32]$runtime[0].ProcessId, $Target) | ConvertTo-Json -Compress
  return
}

if ($Action -eq 'links') {
  $shell = New-Object -ComObject WScript.Shell
  @('DesktopDirectory', 'Programs') | ForEach-Object {
    $path = Join-Path ([Environment]::GetFolderPath($_, 'DoNotVerify')) 'KevinLauncher.lnk'
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      $link = $shell.CreateShortcut($path)
      [pscustomobject]@{ path = $path; target = $link.TargetPath; workingDirectory = $link.WorkingDirectory; arguments = $link.Arguments }
    }
  } | ConvertTo-Json -Compress
  return
}

if ($Action -eq 'integration') {
  $registry = [Microsoft.Win32.Registry]::CurrentUser
  $uninstall = $registry.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\KevinLauncher')
  $app = $registry.OpenSubKey('Software\KevinLauncher')
  $task = Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object TaskName -EQ KevinLauncher
  $uninstallInfo = $null
  $program = $null
  $dataPath = $null
  $taskInfo = $null
  if ($uninstall) {
    $uninstallInfo = [ordered]@{
      name = $uninstall.GetValue('DisplayName'); version = $uninstall.GetValue('DisplayVersion')
      path = $uninstall.GetValue('InstallLocation'); command = $uninstall.GetValue('UninstallString')
    }
    $uninstall.Dispose()
  }
  if ($app) {
    $program = $app.GetValue('InstallLocation')
    $dataPath = $app.GetValue('DataDir')
    $app.Dispose()
  }
  if ($task) {
    $taskInfo = [ordered]@{ target = $task.Actions.Execute; arguments = $task.Actions.Arguments; level = $task.Principal.RunLevel.ToString() }
  }
  [ordered]@{ uninstall = $uninstallInfo; program = $program; data = $dataPath; task = $taskInfo } | ConvertTo-Json -Compress -Depth 5
  return
}

if ($Action -eq 'launch') {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $Target
  $start.WorkingDirectory = Split-Path -LiteralPath $Target
  $start.UseShellExecute = $true
  $process = [System.Diagnostics.Process]::Start($start)
  if ($process) { $process.Id } else { 0 }
  return
}

if ($Action -eq 'close') {
  $process = Get-Process -Id $ProcessId
  if ($process.Path -ine $Target -or $process.ProcessName -ine [IO.Path]::GetFileNameWithoutExtension($layout.runtime)) {
    throw 'Refused to close a process outside the observed installation'
  }
  if (-not $process.CloseMainWindow()) { throw 'Could not close the observed window' }
  return
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class SetupToken {
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

$entry = Join-Path $Target $layout.entry
$runtime = Join-Path $Target $layout.runtime
$filter = "Name = '$($layout.entry)' OR Name = '$($layout.runtime)'"
$running = @(Get-CimInstance Win32_Process -Filter $filter | Where-Object {
  $_.ExecutablePath -ieq $entry -or $_.ExecutablePath -ieq $runtime
} | ForEach-Object {
  $observedId = $_.ProcessId
  try {
    $process = Get-Process -Id $observedId
    $token = [SetupToken]::Read($observedId)
    [ordered]@{
      id = $observedId; parentId = $_.ParentProcessId; path = $_.ExecutablePath
      window = $process.MainWindowHandle -ne [IntPtr]::Zero
      renderer = $_.CommandLine -match '(?:^|\s)--type=renderer(?:\s|$)'
      noSandbox = $_.CommandLine -match '(?:^|\s)--no-sandbox(?:\s|$)'
      elevated = $token[0] -ge 0x3000 -and $token[1] -ne 0
      integrityRid = $token[0]
      restricted = $token[2] -ne 0 -or $token[3] -ne 0
    }
  } catch {
    if (Get-Process -Id $observedId -ErrorAction SilentlyContinue) { throw }
  }
})
$runner = [SetupToken]::Read($PID)
[ordered]@{ processes = $running; runnerIntegrityRid = $runner[0] } | ConvertTo-Json -Compress -Depth 4
