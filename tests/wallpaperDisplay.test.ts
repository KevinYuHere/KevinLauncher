import { describe, expect, it } from 'vitest'
import { MAX_WALLPAPER_EDGE, wallpaperCoverCrop } from '../src/renderer/src/wallpaperDisplay'

describe('wallpaperCoverCrop', () => {
  it('cuts out the part `cover` shows and matches the device pixels exactly', () => {
    // 1308x890 CSS layer at dpr 1.5 → 1962x1335 device px. Height is the
    // limiting side for a 16:9 source, so the visible source band is cropped
    // horizontally and the full height is kept.
    const crop = wallpaperCoverCrop(7680, 4320, 1308, 890, 1.5)
    expect(crop).not.toBeNull()
    expect(crop!.width).toBe(1962)
    expect(crop!.height).toBe(1335)
    expect(crop!.sh).toBeCloseTo(4320, 0)
    // Visible width: 1962 device px at the cover scale (1335 / 4320).
    expect(crop!.sw).toBeCloseTo((1962 * 4320) / 1335, 1)
    // Centered crop.
    expect(crop!.sx).toBeCloseTo((7680 - crop!.sw) / 2, 5)
    expect(crop!.sy).toBeCloseTo(0, 5)
    // One source pixel of the crop maps to ~one prepared pixel.
    expect(crop!.sw / crop!.width).toBeCloseTo(crop!.sh / crop!.height, 3)
  })

  it('centers the crop for landscape and portrait sources', () => {
    const landscape = wallpaperCoverCrop(4000, 2000, 1000, 1000, 1)
    expect(landscape).toMatchObject({ sw: 2000, sh: 2000, width: 1000, height: 1000 })
    expect(landscape!.sx).toBeCloseTo(1000, 5)
    expect(landscape!.sy).toBeCloseTo(0, 5)
    const portrait = wallpaperCoverCrop(2000, 4000, 1000, 1000, 1)
    expect(portrait).toMatchObject({ sw: 2000, sh: 2000, width: 1000, height: 1000 })
    expect(portrait!.sx).toBeCloseTo(0, 5)
    expect(portrait!.sy).toBeCloseTo(1000, 5)
  })

  it('does nothing when the visible source is not bigger than the display', () => {
    // Smaller than the box: upscaling it would only waste memory.
    expect(wallpaperCoverCrop(800, 600, 960, 540, 1)).toBeNull()
    expect(wallpaperCoverCrop(1000, 1000, 1600, 900, 1)).toBeNull()
    // Just above 1:1 (rounding noise) is not worth a re-encode.
    expect(wallpaperCoverCrop(1001, 1001, 1000, 1000, 1)).toBeNull()
  })

  it('bounds the rasterised size for huge windows', () => {
    const crop = wallpaperCoverCrop(16000, 16000, 5000, 5000, 2)
    expect(Math.max(crop!.width, crop!.height)).toBe(MAX_WALLPAPER_EDGE)
    // The crop keeps the requested aspect ratio.
    expect(crop!.width).toBe(crop!.height)
  })

  it('rejects unusable input', () => {
    expect(wallpaperCoverCrop(0, 4320, 1308, 890, 1.5)).toBeNull()
    expect(wallpaperCoverCrop(7680, 4320, 0, 890, 1.5)).toBeNull()
    expect(wallpaperCoverCrop(7680, 4320, 1308, 890, 0)).toBeNull()
  })
})
