# Generates the NSIS installer branding bitmaps (dark background + app icon)
# into build/: installerSidebar.bmp (164x314) and installerHeader.bmp (150x57).
# Run once (or whenever resources/icon.png changes) before packaging.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'resources\icon.png'
$outDir = Join-Path $root 'build'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# Matches the window background colour used by the app (#0f1115).
$background = [System.Drawing.Color]::FromArgb(15, 17, 21)

function New-BrandedBitmap {
  param([int]$Width, [int]$Height, [int]$IconSize, [string]$Path)

  $bitmap = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $icon = [System.Drawing.Image]::FromFile($source)
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.Clear($background)
    $x = [int](($Width - $IconSize) / 2)
    $y = [int](($Height - $IconSize) / 2)
    $graphics.DrawImage($icon, $x, $y, $IconSize, $IconSize)
  } finally {
    $icon.Dispose()
    $graphics.Dispose()
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bitmap.Dispose()
  }
  Write-Host "wrote $Path"
}

New-BrandedBitmap -Width 164 -Height 314 -IconSize 96 -Path (Join-Path $outDir 'installerSidebar.bmp')
New-BrandedBitmap -Width 150 -Height 57 -IconSize 42 -Path (Join-Path $outDir 'installerHeader.bmp')
