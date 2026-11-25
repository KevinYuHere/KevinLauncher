import type { AppEntry, LaunchMethod, Wallpaper } from './types'

/** File extensions treated as looping video wallpapers. */
const VIDEO_EXTS = ['mp4', 'webm', 'm4v', 'mov', 'mkv', 'avi']

/** Whether a stored file name is a video (vs an image). */
export function isVideoFile(name: string | null | undefined): boolean {
  if (!name) return false
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return VIDEO_EXTS.includes(ext)
}

/** A launch method by id (null when missing). */
export function launchMethodById(
  entry: AppEntry,
  id: string | null | undefined
): LaunchMethod | null {
  if (!id) return null
  return entry.launchMethods.find((method) => method.id === id) ?? null
}

/** The app's default launch method (falls back to the first one). */
export function defaultLaunchMethod(entry: AppEntry): LaunchMethod | null {
  return launchMethodById(entry, entry.defaultLaunchMethodId) ?? entry.launchMethods[0] ?? null
}

/** The wallpaper currently shown for an app (clamped to the list bounds). */
export function currentWallpaper(entry: AppEntry): Wallpaper | null {
  if (entry.wallpapers.length === 0) return null
  const index = Math.max(0, Math.min(entry.wallpapers.length - 1, entry.wallpaperIndex))
  return entry.wallpapers[index] ?? null
}
