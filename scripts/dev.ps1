# Runs the app in development mode in its own window, logging to logs\dev.log.
# It relaunches itself elevated (a single UAC prompt) so the launcher runs as
# administrator, which avoids a UAC prompt every time a game is launched and
# lets us track/stop the launched processes reliably.
#
# The current PATH is passed to the elevated instance, because tools like fnm
# install node/npm into a session-specific directory that is not part of the
# machine/user environment.
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$logsDir = Join-Path $root 'logs'
$pathFile = Join-Path $logsDir 'dev-path.txt'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
  Set-Content -LiteralPath $pathFile -Value $env:PATH -Encoding UTF8
  Write-Host 'Requesting administrator privileges...' -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', "`"$PSCommandPath`""
  )
  exit
}

if (Test-Path $pathFile) {
  $env:PATH = (Get-Content -LiteralPath $pathFile -Raw).Trim()
}

Set-Location $root
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$log = Join-Path $logsDir 'dev.log'

Write-Host '== npm run dev (as administrator) ==' -ForegroundColor Cyan
npm.cmd run dev *>&1 | Tee-Object -FilePath $log
