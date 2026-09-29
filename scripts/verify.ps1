# Waits for the dependency install to finish, then runs typecheck and tests.
# Output is written to logs\verify.log so it can be inspected without blocking.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs') | Out-Null
$log = Join-Path $root 'logs\verify.log'
Remove-Item $log -ErrorAction SilentlyContinue

function Write-Log([string]$text) {
  $text | Tee-Object -FilePath $log -Append
}

$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
Write-Log "== waiting for electron install =="
$deadline = (Get-Date).AddMinutes(20)
while (-not (Test-Path $electronExe) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 5
}
Start-Sleep -Seconds 8
Write-Log ("electron binary present: " + (Test-Path $electronExe))

Write-Log "== npm run typecheck =="
npm.cmd run typecheck *>&1 | Tee-Object -FilePath $log -Append

Write-Log "== npm test =="
npm.cmd test *>&1 | Tee-Object -FilePath $log -Append

Write-Log "== done =="
