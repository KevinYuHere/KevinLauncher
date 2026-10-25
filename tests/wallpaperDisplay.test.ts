import { describe, expect, it } from 'vitest'
import { MAX_WALLPAPER_EDGE, wallpaperTargetSize } from '../src/renderer/src/wallpaperDisplay'

describe('wallpaperTargetSize', () => {
  it('downscales an 8K wallpaper to the device-pixel cover size', () => {
    // 1308x890 CSS layer at dpr 1.5 → 1962x1335 device px; height is the
    // limiting side, so the result keeps the source aspect.
    const target = wallpaperTargetSize(7680, 4320, 1308, 890, 1.5)
    expect(target).toEqual({ width: 2373, height: 1335 })
    expect(target!.width / target!.height).toBeCloseTo(7680 / 4320, 2)
  })

  it('keeps landscape and portrait aspect ratios', () => {
    const landscape = wallpaperTargetSize(4000, 2000, 1000, 1000, 1)
    expect(landscape).toEqual({ width: 2000, height: 1000 })
    const portrait = wallpaperTargetSize(2000, 4000, 1000, 1000, 1)
    expect(portrait).toEqual({ width: 1000, height: 2000 })
  })

  it('does nothing when the source already fits the display', () => {
    // Smaller than the box: upscaling it would only waste memory.
    expect(wallpaperTargetSize(800, 600, 960, 540, 1)).toBeNull()
    expect(wallpaperTargetSize(1000, 1000, 1600, 900, 1)).toBeNull()
    // Just above 1:1 (rounding noise) is not worth a re-encode.
    expect(wallpaperTargetSize(1000, 1000, 995, 995, 1)).toBeNull()
  })

  it('bounds the longest edge for very large canvases', () => {
    const target = wallpaperTargetSize(16000, 16000, 4000, 4000, 2, MAX_WALLPAPER_EDGE)
    expect(Math.max(target!.width, target!.height)).toBe(MAX_WALLPAPER_EDGE)
  })

  it('rejects unusable input', () => {
    expect(wallpaperTargetSize(0, 4320, 1308, 890, 1.5)).toBeNull()
    expect(wallpaperTargetSize(7680, 4320, 0, 890, 1.5)).toBeNull()
    expect(wallpaperTargetSize(7680, 4320, 1308, 890, 0)).toBeNull()
  })
})
