function parseColor(value: string): [number, number, number] {
  const text = value.trim()
  const hex = /^#?([0-9a-f]{6})$/i.exec(text)
  if (hex) {
    const v = parseInt(hex[1], 16)
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
  }
  const short = /^#?([0-9a-f]{3})$/i.exec(text)
  if (short) {
    const [r, g, b] = short[1].split('')
    return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)]
  }
  const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(text)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return [139, 124, 246]
}

function toHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, Math.round(l * 100)]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)]
}

function readVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

export interface TriangleBurstOptions {
  count?: number
  size?: number
  distance?: number
  duration?: number
}

/**
 * 霆骇列律 geometric particle burst: small triangles fly out from a point in the
 * current theme colour. Shared by the global click effect and the games-bar
 * expand/collapse toggle.
 */
export function burstThemeTriangles(
  x: number,
  y: number,
  options: TriangleBurstOptions = {}
): void {
  const brand = parseColor(readVar('--brand', '#8b7cf6'))
  const [baseH, baseS, baseL] = toHsl(brand)
  const count = options.count ?? 12
  const baseSize = options.size ?? 12
  const spread = options.distance ?? 120
  const baseDuration = options.duration ?? 1100
  const layer = document.createElement('div')
  layer.className = 'theme-click-burst'
  document.body.appendChild(layer)
  let longest = 0
  for (let i = 0; i < count; i += 1) {
    const shard = document.createElement('i')
    shard.className = 'theme-click-shard'
    const size = baseSize * (0.65 + Math.random() * 0.9)
    shard.style.width = `${size.toFixed(1)}px`
    shard.style.height = `${size.toFixed(1)}px`
    shard.style.left = `${x}px`
    shard.style.top = `${y}px`
    shard.style.marginLeft = `${-size / 2}px`
    shard.style.marginTop = `${-size / 2}px`
    const color = `hsl(${Math.round(baseH + (Math.random() * 20 - 10))} ${Math.round(
      Math.max(30, Math.min(100, baseS + (Math.random() * 18 - 9)))
    )}% ${Math.round(Math.max(38, Math.min(86, baseL + (Math.random() * 22 - 11))))}%)`
    shard.style.background = color
    shard.style.boxShadow = `0 0 7px ${color}`
    const angle = Math.random() * Math.PI * 2
    const distance = spread * (0.45 + Math.random() * 0.75)
    const dx = Math.cos(angle) * distance
    const dy = Math.sin(angle) * distance
    const rot = Math.random() * 280 - 140
    const delay = Math.random() * 90
    const duration = baseDuration * (0.85 + Math.random() * 0.35)
    longest = Math.max(longest, delay + duration)
    layer.appendChild(shard)
    shard.animate(
      [
        { transform: 'translate(0, 0) rotate(0deg) scale(0.45)', opacity: 0.95 },
        {
          offset: 0.16,
          transform: 'translate(0, 0) rotate(0deg) scale(1.05)',
          opacity: 1
        },
        {
          transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${rot.toFixed(
            1
          )}deg) scale(0.45)`,
          opacity: 0
        }
      ],
      {
        duration,
        delay,
        easing: 'cubic-bezier(0.16, 0.8, 0.24, 1)',
        fill: 'both'
      }
    )
  }
  window.setTimeout(() => layer.remove(), longest + 120)
}
