# Builds the official Windows layout on a disposable runner. This script has no
# publication step and is also used by the installation acceptance workflow.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'This build entry expects a disposable GitHub-hosted Windows runner'
}
Set-Location (Split-Path -Parent $PSScriptRoot)
$version = (& node -p "require('./package.json').version")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
  throw 'An official layout requires a stable version'
}
$env:KEVIN_BUILD_IDENTITY = 'production'
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'

& npm.cmd run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node node_modules/electron-builder/cli.js --win --x64 --dir --publish never
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node node_modules/electron-builder/cli.js --win --x64 --prepackaged release/win-unpacked --publish never
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node scripts/windows-executable.js release/win-unpacked/KevinLauncher.exe "release/KevinLauncher-Installer-$version.exe"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node scripts/windows-executable.js --as-invoker release/win-unpacked/KevinLauncherRuntime.exe
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node scripts/extract-changelog.mjs $version release/RELEASE_NOTES.md
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node scripts/build-update-payload.mjs release/win-unpacked $version
exit $LASTEXITCODE
