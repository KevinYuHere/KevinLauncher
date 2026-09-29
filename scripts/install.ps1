# Installs project dependencies using the npmmirror registry / Electron mirror.
# Intended to be launched in its own window (non-blocking).
$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '..')

$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

Write-Host '== npm install (npmmirror) ==' -ForegroundColor Cyan
Write-Host "registry : $((npm config get registry))"
Write-Host "electron : $env:ELECTRON_MIRROR"
npm install --no-audit --no-fund
Write-Host "== npm install exited with code $LASTEXITCODE ==" -ForegroundColor Cyan
