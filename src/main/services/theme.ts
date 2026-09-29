import { nativeImage } from 'electron'

function toHex(r: number, g: number, b: number): string {
  const clamp = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
  }
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = l * 255
    return [v, v, v]
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255]
}

/**
 * Extract a vivid accent colour from an image file, suitable as a theme colour.
 * Uses Electron's nativeImage so no extra dependencies are needed.
 */
export function extractAccent(filePath: string): string | null {
  try {
    const image = nativeImage.createFromPath(filePath)
    if (image.isEmpty()) return null
    const small = image.resize({ width: 64, height: 64, quality: 'good' })
    const bitmap = small.getBitmap() // BGRA

    let best = { sat: -1, r: 0, g: 0, b: 0 }
    let sumR = 0
    let sumG = 0
    let sumB = 0
    let count = 0

    for (let i = 0; i + 3 < bitmap.length; i += 4) {
      const b = bitmap[i]
      const g = bitmap[i + 1]
      const r = bitmap[i + 2]
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const lum = (max + min) / 2
      if (lum < 28 || lum > 230) continue
      const sat = max - min
      sumR += r
      sumG += g
      sumB += b
      count += 1
      if (sat > best.sat) best = { sat, r, g, b }
    }

    let r: number
    let g: number
    let b: number
    if (best.sat > 45) {
      r = best.r
      g = best.g
      b = best.b
    } else if (count > 0) {
      r = sumR / count
      g = sumG / count
      b = sumB / count
    } else {
      return null
    }

    const [h, s, l] = rgbToHsl(r, g, b)
    const [nr, ng, nb] = hslToRgb(h, Math.min(1, Math.max(0.55, s)), Math.min(0.62, Math.max(0.46, l)))
    return toHex(nr, ng, nb)
  } catch {
    return null
  }
}
