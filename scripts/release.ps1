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
  [switch]$Draft,
  [switch]$Prerelease,
  # Mark the release as critical (no postpone, auto download).
  [switch]$Critical
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$packageVersion = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if (-not $Version) {
  $Version = $packageVersion
} elseif ($Version -ne $packageVersion) {
  # ASCII only: Windows PowerShell 5.1 reads this UTF-8 file as ANSI.
  throw "Version $Version does not match package.json ($packageVersion); bump package.json first"
}
# The client compares releases with a SemVer comparator. A non-SemVer version
# would be ordered as 0.0.0 and silently never offered again, so reject it here
# instead of failing halfway through the build.
if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
  throw "Version $Version is not SemVer (expected 1.2.3 or 1.2.3-beta.1); the updater cannot compare it"
}

# The release policy belongs to exactly one version: it is embedded in that
# version's payload and applied on its first start. A stale file must be removed
# before the next release (or re-targeted) - never silently inherited.
$policyPath = Join-Path $root 'theme-policy.json'
if (Test-Path $policyPath) {
  try {
    $policy = [System.IO.File]::ReadAllText($policyPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  } catch {
    throw "theme-policy.json cannot be parsed: $($_.Exception.Message)"
  }
  if ($policy.version -ne $Version) {
    throw "theme-policy.json belongs to $($policy.version), but this release is $Version. Delete it, or set its version to $Version if this release also changes user settings."
  }
}
# A pre-release version always publishes as a GitHub pre-release (the same rule
# the CI workflow applies); otherwise stable users would be served the beta via
# `releases/latest`.
$isPrerelease = [bool]$Prerelease -or ($Version -match '-')
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
# The release notes come from CHANGELOG.md (newest version first). Publishing is
# refused when the file is missing or has no section for this version - the same
# rule the CI workflow enforces.
$notesFile = Join-Path $root 'release\RELEASE_NOTES.md'
node scripts/extract-changelog.mjs $Version $notesFile
if ($LASTEXITCODE -ne 0) { throw "CHANGELOG.md has no section for $Version; refusing to publish" }
if ($Critical) { $env:KL_CRITICAL_UPDATE = '1' } else { Remove-Item Env:\KL_CRITICAL_UPDATE -ErrorAction SilentlyContinue }
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
  if ($isPrerelease) { & $gh release edit $tag --prerelease }
} else {
  $createArgs = @('release', 'create', $tag) + $assets + @('--title', "KevinLauncher $Version", '--notes-file', $notesFile)
  if ($Draft) { $createArgs += '--draft' }
  if ($isPrerelease) { $createArgs += '--prerelease' }
  & $gh @createArgs
}
if ($LASTEXITCODE -ne 0) { throw 'gh release failed' }
Write-Host "== published https://github.com/KevinYuHere/KevinLauncher/releases/tag/$tag ==" -ForegroundColor Green
