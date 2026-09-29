function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!match) return null
  const value = parseInt(match[1], 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

function lighten(hex: string, amount: number): string {
  const color = parseHex(hex)
  if (!color) return hex
  const mix = (v: number): string =>
    Math.round(v + (255 - v) * amount)
      .toString(16)
      .padStart(2, '0')
  return `#${mix(color.r)}${mix(color.g)}${mix(color.b)}`
}

/** WCAG relative luminance (0 = black, 1 = white). */
function relativeLuminance(color: { r: number; g: number; b: number }): number {
  const channel = (value: number): number => {
    const s = value / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/** Apply (or reset) the accent colour used across the whole UI. */
export function applyTheme(hex: string | null): void {
  const root = document.documentElement
  if (!hex) {
    root.style.removeProperty('--brand')
    root.style.removeProperty('--brand-hover')
    root.style.removeProperty('--brand-dim')
    root.style.removeProperty('--brand-line')
    root.style.removeProperty('--on-brand')
    root.style.removeProperty('--on-brand-soft')
    return
  }
  const color = parseHex(hex)
  root.style.setProperty('--brand', hex)
  root.style.setProperty('--brand-hover', lighten(hex, 0.18))
  if (color) {
    root.style.setProperty('--brand-dim', `rgba(${color.r}, ${color.g}, ${color.b}, 0.18)`)
    root.style.setProperty('--brand-line', `rgba(${color.r}, ${color.g}, ${color.b}, 0.5)`)
    // Text / icons drawn on top of the accent colour. Bright accents (close to
    // white) need dark foregrounds to stay legible.
    const light = relativeLuminance(color) > 0.5
    root.style.setProperty('--on-brand', light ? '#10131a' : '#ffffff')
    root.style.setProperty(
      '--on-brand-soft',
      light ? 'rgba(16, 19, 26, 0.6)' : 'rgba(255, 255, 255, 0.6)'
    )
  }
}
