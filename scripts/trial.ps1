# Builds a local-only installer, optionally copying an explicitly selected profile.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\trial.ps1 [-DataDir <path>] [-Reseed]
param(
  [string]$DataDir,
  [switch]$Reseed
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

if ($Reseed -and -not $DataDir) { throw '-Reseed requires -DataDir' }
if ($DataDir) {
  if (Get-Process KevinLauncherTrial,KevinLauncherTrialRuntime,KevinLauncherTrial-Installer-* -ErrorAction SilentlyContinue) {
    throw 'Close the trial and its installer before copying data'
  }
  $seedArgs = @('scripts/seed-trial.mjs', $DataDir)
  if ($Reseed) { $seedArgs += '--replace' }
  & node @seedArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& npm.cmd run package:test
exit $LASTEXITCODE
