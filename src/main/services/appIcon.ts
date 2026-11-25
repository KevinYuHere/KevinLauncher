import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { execFile } from 'child_process'
import { existsSync, promises as fs, renameSync } from 'fs'
import { join } from 'path'
import { AppStore } from './appStore'
import { BrandStore } from './brand'
import { brandIcoName, openMediaDirectory } from './mediaFiles'
import { setTrayImage } from './behavior'
import { log } from './logger'
import { trialBuild, trialShortcuts } from './buildIdentity'

function bundledIcon(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(app.getAppPath(), 'resources', name)
}

/**
 * Shortcut locations to keep in sync.
 *
 * The desktop path must come from `app.getPath('desktop')`: the folder is often
 * redirected (OneDrive, or a desktop that was moved to another drive), in which
 * case `%USERPROFILE%\Desktop` does not exist and its shortcut was never
 * updated — which is exactly why the desktop icon did not change.
 */
function shortcutCandidates(): string[] {
  if (trialBuild) return Object.values(trialShortcuts())
  const paths: string[] = []
  const push = (path: string | undefined | null): void => {
    if (path) paths.push(path)
  }

  try {
    push(join(app.getPath('desktop'), 'KevinLauncher.lnk'))
  } catch {
    /* no desktop folder available */
  }
  push(
    join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'KevinLauncher.lnk'
    )
  )
  if (process.env.PROGRAMDATA) {
    push(
      join(process.env.PROGRAMDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'KevinLauncher.lnk')
    )
  }
  if (process.env.PUBLIC) push(join(process.env.PUBLIC, 'Desktop', 'KevinLauncher.lnk'))
  // Fallbacks for setups where the desktop could not be resolved.
  if (process.env.USERPROFILE) {
    push(join(process.env.USERPROFILE, 'Desktop', 'KevinLauncher.lnk'))
    push(join(process.env.USERPROFILE, 'OneDrive', 'Desktop', 'KevinLauncher.lnk'))
  }
  return [...new Set(paths)]
}

/**
 * PNG (window / tray) and ICO (shortcuts / exe) of the current launcher icon.
 * Falls back to the icon bundled with the app.
 */
export async function launcherIconPaths(iconFile?: string | null): Promise<{ png: string; ico: string }> {
  try {
    const file = iconFile === undefined ? (await AppStore.launcherSettings()).iconFile : iconFile
    if (file) {
      await openMediaDirectory(BrandStore.dir())
      const png = join(BrandStore.dir(), file)
      if ((await fs.lstat(png)).isFile()) return { png, ico: join(BrandStore.dir(), brandIcoName(file)) }
    }
  } catch {
    /* fall back to the bundled default */
  }
  return { png: bundledIcon('icon.png'), ico: bundledIcon('icon.ico') }
}

/**
 * Tells the shell to forget the cached bitmaps and re-read the shortcut icons.
 *
 * Three layers cache them and each needs its own nudge:
 *  1. the on-disk icon database (`ie4uinit.exe -show`),
 *  2. the shell's in-memory item cache (`SHChangeNotify(SHCNE_UPDATEITEM)` per
 *     .lnk, plus `SHCNE_ASSOCCHANGED`),
 *  3. the Start Menu host's own cache — only restarting
 *     `StartMenuExperienceHost.exe` drops it (Windows starts it again by itself).
 *
 * `restartStartMenu` is only used for user-initiated icon changes, so a normal
 * launch never makes the Start Menu blink.
 */
function notifyShell(
  shortcuts: string[],
  options: { iconCache: boolean; restartStartMenu: boolean }
): void {
  if (options.iconCache) {
    const list = shortcuts.map((path) => `'${path.replace(/'/g, "''")}'`).join(',')
    const script = `
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class KevinShellNotify {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
foreach ($p in @(${list})) {
  $ptr = [System.Runtime.InteropServices.Marshal]::StringToHGlobalUni($p)
  [KevinShellNotify]::SHChangeNotify(0x2000, 0x0005, $ptr, [IntPtr]::Zero)
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
}
[KevinShellNotify]::SHChangeNotify(0x08000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)
`
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true },
      () => {
        /* best effort */
      }
    )
  }

  try {
    execFile('ie4uinit.exe', ['-show'], { windowsHide: true }, () => {
      /* best effort */
    })
  } catch {
    /* not available on every build */
  }

  if (options.restartStartMenu) {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-Process StartMenuExperienceHost -ErrorAction SilentlyContinue | Stop-Process -Force'
      ],
      { windowsHide: true },
      () => {
        /* Windows starts the Start Menu again automatically */
      }
    )
  }
}

/**
 * Renames a shortcut to a temporary name and back: the shell treats it as a new
 * file and re-reads its icon, which is what makes the change appear in the Start
 * Menu / on the desktop without rebuilding the whole icon cache.
 */
function touchShortcut(path: string): void {
  try {
    const temp = `${path}.${Date.now().toString(36)}.tmp`
    renameSync(path, temp)
    renameSync(temp, path)
  } catch {
    /* best effort */
  }
}

/**
 * Apply the launcher icon to every window (taskbar / Alt-Tab), the tray, and
 * any Start Menu / Desktop shortcuts.
 */
export async function applyLauncherIcon(
  options: { refreshShell?: boolean; iconFile?: string | null; reportFailure?: boolean } = {}
): Promise<void> {
  const { png, ico } = await launcherIconPaths(options.iconFile)

  const image = nativeImage.createFromPath(png)
  if (!image.isEmpty()) {
    for (const win of BrowserWindow.getAllWindows()) win.setIcon(image)
    setTrayImage(image)
  }

  const updated: string[] = []
  const failed: string[] = []
  for (const path of shortcutCandidates()) {
    try {
      if (!existsSync(path)) continue
      const details = shell.readShortcutLink(path)
      // Re-create rather than update: `create` also succeeds when the file is in
      // a state `update` refuses, and it always rewrites the icon.
      if (!shell.writeShortcutLink(path, 'create', { ...details, icon: ico, iconIndex: 0 })) {
        throw new Error('无法写入快捷方式')
      }
      touchShortcut(path)
      updated.push(path)
      const applied = shell.readShortcutLink(path)
      log(`icon: shortcut ${path} -> ${applied.icon}#${applied.iconIndex}`)
    } catch (error) {
      failed.push(path)
      log(`icon: shortcut ${path} failed (${(error as Error).message})`)
    }
  }

  if (!trialBuild) notifyShell(updated, {
    iconCache: true,
    // Only a user-initiated change may restart the Start Menu host.
    restartStartMenu: options.refreshShell === true
  })
  if (options.reportFailure && failed.length) throw new Error(`更新 ${failed.length} 个快捷方式的图标失败`)
}
