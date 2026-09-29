; Extra NSIS customisation for the KevinLauncher installer.
; electron-builder inserts these macros around the generated MUI2 wizard, so we
; only add safe tweaks here (the dark branding comes from the sidebar/header
; bitmaps in build/ and the installer icon).
!macro customHeader
  BrandingText "KevinLauncher"
!macroend

; Kept for completeness: runs after the files are copied. The Start Menu and
; desktop shortcuts plus the install directory page are configured in
; electron-builder.yml (no user prompt for shortcuts).
!macro customInstall
!macroend
