import { join } from 'path'
import type { AppEntry } from '@shared/types'
import { currentWallpaper, isVideoFile } from '@shared/appEntry'
import { BgStore } from './background'
import { extractAccent } from './theme'

/**
 * Re-derives an app's theme colour from its **current wallpaper** when
 * auto-theme is on. Videos cannot be sampled, so the previous colour is kept.
 */
export async function applyAutoTheme(entry: AppEntry): Promise<void> {
  if (!entry.autoTheme) return
  const wallpaper = currentWallpaper(entry)
  if (!wallpaper || isVideoFile(wallpaper.file)) return
  const color = await extractAccent(join(BgStore.bgDir(), wallpaper.file))
  if (color && entry.autoTheme && currentWallpaper(entry)?.file === wallpaper.file) entry.themeColor = color
}
