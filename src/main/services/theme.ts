import { nativeImage } from 'electron'
import { accentFromRgba } from '@shared/accent'

/**
 * Extract a vivid accent colour from an image file, suitable as a theme colour.
 * Uses Electron's nativeImage so no extra dependencies are needed.
 */
export function extractAccent(filePath: string): string | null {
  try {
    const image = nativeImage.createFromPath(filePath)
    if (image.isEmpty()) return null
    const small = image.resize({ width: 64, height: 64, quality: 'good' })
    const bitmap = small.toBitmap() // BGRA
    const rgba = new Uint8ClampedArray(bitmap.length)
    for (let i = 0; i + 3 < bitmap.length; i += 4) {
      rgba[i] = bitmap[i + 2]
      rgba[i + 1] = bitmap[i + 1]
      rgba[i + 2] = bitmap[i]
      rgba[i + 3] = bitmap[i + 3]
    }
    return accentFromRgba(rgba)
  } catch {
    return null
  }
}
