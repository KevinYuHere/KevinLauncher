export const MEDIA_DIRECTORIES = ['icons', 'bg', 'brand'] as const
export type MediaDirectory = typeof MEDIA_DIRECTORIES[number]

interface ConfigMedia {
  apps: readonly {
    iconFile?: unknown
    backgroundFile?: unknown
    wallpapers?: readonly { file?: unknown }[]
  }[]
  launcher?: { iconFile?: unknown }
}

/** Managed media paths use one Windows filename, including legacy Unicode names. */
export function isMediaFilename(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    !/[\\/:*?"<>|\x00-\x1f]|[ .]$/.test(value) &&
    !/^(?:CON|NUL|PRN|AUX|COM[1-9¹²³]|LPT[1-9¹²³])\s*(?:\.|$)/i.test(value)
}

export function* configMediaReferences(config: ConfigMedia, legacyBackground = false): Generator<[MediaDirectory, unknown]> {
  for (const entry of config.apps) {
    if (entry.iconFile != null) yield ['icons', entry.iconFile]
    if (legacyBackground && entry.backgroundFile != null && entry.wallpapers === undefined) {
      yield ['bg', entry.backgroundFile]
    }
    for (const wallpaper of entry.wallpapers ?? []) yield ['bg', wallpaper.file]
  }
  if (config.launcher?.iconFile != null) yield ['brand', config.launcher.iconFile]
}
