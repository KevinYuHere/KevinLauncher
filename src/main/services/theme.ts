import { nativeImage } from 'electron'
import { accentFromRgba } from '@shared/accent'

// Imported wallpaper filenames are immutable. Share an in-flight thumbnail and
// its tiny colour result across rotations; failures remain retryable.
const colors = new Map<string, Promise<string | null>>()

/** Extract a theme colour from an asynchronous Windows thumbnail. */
export function extractAccent(filePath: string): Promise<string | null> {
  const cached = colors.get(filePath)
  if (cached) return cached
  const result = thumbnailAccent(filePath)
  colors.set(filePath, result)
  if (colors.size > 256) colors.delete(colors.keys().next().value!)
  void result.then(color => {
    if (!color && colors.get(filePath) === result) colors.delete(filePath)
  })
  return result
}

async function thumbnailAccent(filePath: string): Promise<string | null> {
  try {
    const image = await nativeImage.createThumbnailFromPath(filePath, { width: 64, height: 64 })
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
