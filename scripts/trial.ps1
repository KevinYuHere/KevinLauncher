# Sandbox trial launcher.
#
# Runs the freshly built app against a **persistent** sandbox data directory
# (via KEVIN_LAUNCHER_DATA_DIR) so trying the build never modifies the real data.
# The sandbox is seeded from the currently used data directory **once** and then
# reused across runs, so changes you make in the sandbox accumulate.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\trial.ps1 [-DataDir <path>] [-Reseed]
param(
  [string]$DataDir,
  [switch]$Reseed
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Get-CurrentDataDir {
  if ($DataDir) { return $DataDir }
  try {
    # Out-String: `reg query` returns one string per line, and `-match` against
    # an array does not populate $Matches — join it into a single string first.
    $out = (reg query 'HKCU\Software\KevinLauncher' /v DataDir 2>$null | Out-String)
    if ($out -match 'DataDir\s+REG_\w+\s+(.+?)\s*(\r?\n|$)') { return $Matches[1].Trim() }
  } catch { }
  return Join-Path $env:APPDATA 'kevin-launcher'
}

if (-not (Test-Path -LiteralPath (Join-Path $root 'out\main\index.js'))) {
  throw 'Build output missing. Run: npm run build'
}

# Persistent sandbox data directory (reused between runs).
$sandbox = Join-Path $env:LOCALAPPDATA 'KevinLauncherSandbox'
$seeded = Test-Path -LiteralPath (Join-Path $sandbox 'config.json')

if ($Reseed -or -not $seeded) {
  $source = Get-CurrentDataDir
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Data directory not found: $source (build the app first, or pass -DataDir)"
  }
  Write-Host "Seeding sandbox: $source -> $sandbox"
  if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $sandbox | Out-Null
  # Skip Chromium/Electron caches and transient files (locked / regenerated).
  $skip = @(
    'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
    'ShaderCache', 'GrShaderCache', 'blob_storage', 'Local Storage', 'Session Storage',
    'IndexedDB', 'Network', 'Shared Dictionary', 'Service Worker', 'Crashpad', 'WebStorage',
    'Dictionaries', 'logs', 'update-staging', 'predownload'
  )
  foreach ($item in Get-ChildItem -LiteralPath $source -Force) {
    if ($skip -contains $item.Name) { continue }
    if ($item.Name -like '*.log' -or $item.Name -like 'simulate.*' -or $item.Name -like 'singleton*') { continue }
    Copy-Item -LiteralPath $item.FullName -Destination $sandbox -Recurse -Force -ErrorAction SilentlyContinue
  }
} else {
  Write-Host "Reusing sandbox: $sandbox (use -Reseed to reset it)"
}

Write-Host "Launching sandbox trial (real data is not touched): $sandbox"
$env:KEVIN_LAUNCHER_DATA_DIR = $sandbox
& (Join-Path $root 'node_modules\.bin\electron.cmd') $root

