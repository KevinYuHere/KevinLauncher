# Builds and publishes a release:
#   1. electron-vite build
#   2. electron-builder --dir  (then rcedit applies the exe icon locally)
#   3. electron-builder --prepackaged   -> self-drawn installer (portable target)
#   4. node scripts/build-update-payload.mjs -> KevinLauncher-<v>-app.zip + manifest
#   5. gh release create/upload (installer, app payload, manifest)
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\release.ps1
#         powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Version 0.1.0 -Notes "..." -Draft
#         powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -FakeElectron 34.0.0
#           (records a different Electron version in the manifest to test the
#            runtime-upgrade path)
param(
  [string]$Version = '',
  [string]$Notes = '',
  [string]$FakeElectron = '',
  [switch]$SkipUpload,
  [switch]$Draft
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $Version) {
  $Version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
}
$tag = "v$Version"
Write-Host "== releasing $tag ==" -ForegroundColor Cyan

function Find-Gh {
  $cmd = Get-Command gh -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $fallback = Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'
  if (Test-Path $fallback) { return $fallback }
  throw 'gh (GitHub CLI) not found'
}

# ---------------------------------------------------------------- 1. build
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'electron-vite build failed' }

# ------------------------------------------------- 2. unpacked + exe icon
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
npx.cmd electron-builder --win --dir
if ($LASTEXITCODE -ne 0) { throw 'electron-builder --dir failed' }

$exe = Join-Path $root 'release\win-unpacked\KevinLauncher.exe'
$rcedit = Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign" -Recurse -Filter rcedit-x64.exe -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($rcedit) {
  & $rcedit.FullName $exe --set-icon (Join-Path $root 'resources\icon.ico')
} else {
  Write-Host '!! rcedit not cached: exe icon not applied' -ForegroundColor Yellow
}

# ------------------------------- 3. installer (self-drawn, portable target)
npx.cmd electron-builder --win --prepackaged (Join-Path $root 'release\win-unpacked') --publish never
if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }

# --------------------------------------- 4. update payload assets
# The notes are embedded into the manifest as well, so the free
# `releases/latest/download/update-manifest.json` path can show them without an
# API call.
if (-not $Notes) {
  $Notes = "KevinLauncher $Version`n`n- 详见仓库提交记录 https://github.com/KevinYuHere/KevinLauncher/commits/main"
}
Set-Content -LiteralPath (Join-Path $root 'release\RELEASE_NOTES.md') -Value $Notes -Encoding UTF8
if ($FakeElectron) {
  node scripts/build-update-payload.mjs (Join-Path $root 'release\win-unpacked') $Version $FakeElectron
} else {
  node scripts/build-update-payload.mjs (Join-Path $root 'release\win-unpacked') $Version
}
if ($LASTEXITCODE -ne 0) { throw 'build-update-payload failed' }

$assets = @(
  (Join-Path $root "release\KevinLauncher-Installer-$Version.exe"),
  (Join-Path $root "release\KevinLauncher-$Version-app.zip"),
  (Join-Path $root 'release\update-manifest.json')
)
$assets | ForEach-Object {
  if (-not (Test-Path $_)) { throw "missing asset: $_" }
  Write-Host ("  {0} ({1:N1} MB)" -f (Split-Path $_ -Leaf), ((Get-Item $_).Length / 1MB))
}

if ($SkipUpload) {
  Write-Host '== built, upload skipped ==' -ForegroundColor Cyan
  exit 0
}

# ------------------------------------------------------------ 5. publish
$gh = Find-Gh
# `gh release view` writes to stderr when the tag does not exist; with
# $ErrorActionPreference = 'Stop' that would abort the script, so relax it here.
$ErrorActionPreference = 'Continue'
& $gh release view $tag --json tagName > $null 2>&1
$exists = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = 'Stop'
if ($exists) {
  Write-Host "release $tag exists -> uploading with --clobber" -ForegroundColor Yellow
  & $gh release upload $tag @assets --clobber
} else {
  $createArgs = @('release', 'create', $tag) + $assets + @('--title', "KevinLauncher $Version", '--notes', $Notes)
  if ($Draft) { $createArgs += '--draft' }
  & $gh @createArgs
}
if ($LASTEXITCODE -ne 0) { throw 'gh release failed' }
Write-Host "== published https://github.com/KevinYuHere/KevinLauncher/releases/tag/$tag ==" -ForegroundColor Green
