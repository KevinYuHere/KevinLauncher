# Installs the checked-in npm lockfile and its matching Electron runtime.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

& npm.cmd ci --registry=https://registry.npmjs.org/ --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node node_modules/electron/install.js
exit $LASTEXITCODE
