import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { runPowerShell } from '../services/powershell'

/**
 * Installed-font enumeration for the settings page. The list is cached on disk
 * (enumerating takes ~1 s); the cache is versioned because older builds stored
 * mojibake names (PowerShell's OEM output encoding).
 */
const FONT_CACHE_VERSION = 2

interface FontCacheFile {
  version: number
  fonts: string[]
}

let fontCache: string[] | null = null

const fontCacheFile = (): string => join(app.getPath('userData'), 'fonts.json')

/** Enumerate installed font families (slow) and persist the result. */
async function enumerateFonts(): Promise<string[]> {
  const script =
    'Add-Type -AssemblyName System.Drawing; ' +
    '(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }'
  try {
    const stdout = await runPowerShell(script, { maxBuffer: 4 * 1024 * 1024 })
    const list = [...new Set(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b)
    )
    fontCache = list
    const cache: FontCacheFile = { version: FONT_CACHE_VERSION, fonts: list }
    await fs.writeFile(fontCacheFile(), JSON.stringify(cache), 'utf-8').catch(() => undefined)
    return list
  } catch {
    return fontCache ?? []
  }
}

/** Font family names. Returns the persisted cache instantly, then refreshes. */
async function listSystemFonts(): Promise<string[]> {
  if (fontCache) return fontCache
  try {
    const parsed = JSON.parse(await fs.readFile(fontCacheFile(), 'utf-8')) as FontCacheFile
    if (parsed?.version === FONT_CACHE_VERSION && Array.isArray(parsed.fonts) && parsed.fonts.length) {
      fontCache = parsed.fonts
      void enumerateFonts()
      return parsed.fonts
    }
  } catch {
    /* no (usable) cache yet */
  }
  return enumerateFonts()
}

/** Warm the font cache in the background (so the settings page opens instantly). */
export function warmUpFonts(): void {
  void listSystemFonts()
}

export function registerFontsIpc(): void {
  ipcMain.handle('fonts:list', () => listSystemFonts())
}
