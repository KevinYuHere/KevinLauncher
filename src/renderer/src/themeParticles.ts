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

/** Matches the launch-button mark, so bursts and the real star look the same. */
const MITIA_STAR_PATH =
  'M50 2C50 39.4 60 50 78 50C60 50 50 60.6 50 98C50 60.6 40 50 22 50C40 50 50 39.4 50 2Z'

/** One fixed layer for all mitia particles (removed when empty). */
function mitiaLayer(): HTMLElement {
  let layer = document.querySelector<HTMLElement>('.mitia-burst-layer')
  if (!layer) {
    layer = document.createElement('div')
    layer.className = 'mitia-burst-layer'
    document.body.appendChild(layer)
  }
  return layer
}

/** Three molecule silhouettes so bursts also show several "formulas". */
const MOLECULE_SVGS = [
  '<svg viewBox="0 0 64 32" width="64" height="32">' +
    '<line x1="14" y1="16" x2="50" y2="16" stroke="#9d8bf5" stroke-width="2" stroke-opacity=".55"/>' +
    '<circle cx="14" cy="16" r="10" fill="#1b1240" stroke="#e8c87a" stroke-width="2.2"/>' +
    '<circle cx="50" cy="16" r="7.5" fill="#1b1240" stroke="#b9a8f6" stroke-width="2"/>' +
    '</svg>',
  '<svg viewBox="0 0 64 32" width="64" height="32">' +
    '<line x1="10" y1="22" x2="34" y2="9" stroke="#9d8bf5" stroke-width="2" stroke-opacity=".55"/>' +
    '<line x1="34" y1="9" x2="55" y2="22" stroke="#9d8bf5" stroke-width="2" stroke-opacity=".55"/>' +
    '<circle cx="10" cy="22" r="8" fill="#1b1240" stroke="#e8c87a" stroke-width="2"/>' +
    '<circle cx="34" cy="9" r="9.5" fill="#1b1240" stroke="#e8c87a" stroke-width="2.2"/>' +
    '<circle cx="55" cy="22" r="6" fill="#1b1240" stroke="#b9a8f6" stroke-width="1.8"/>' +
    '</svg>',
  '<svg viewBox="0 0 64 32" width="64" height="32">' +
    '<line x1="32" y1="7" x2="55" y2="16" stroke="#9d8bf5" stroke-width="1.6" stroke-opacity=".5"/>' +
    '<line x1="55" y1="16" x2="32" y2="25" stroke="#9d8bf5" stroke-width="1.6" stroke-opacity=".5"/>' +
    '<line x1="32" y1="25" x2="9" y2="16" stroke="#9d8bf5" stroke-width="1.6" stroke-opacity=".5"/>' +
    '<line x1="9" y1="16" x2="32" y2="7" stroke="#9d8bf5" stroke-width="1.6" stroke-opacity=".5"/>' +
    '<circle cx="32" cy="7" r="7" fill="#1b1240" stroke="#e8c87a" stroke-width="2"/>' +
    '<circle cx="55" cy="16" r="6" fill="#1b1240" stroke="#b9a8f6" stroke-width="1.8"/>' +
    '<circle cx="32" cy="25" r="6.5" fill="#1b1240" stroke="#e8c87a" stroke-width="1.8"/>' +
    '<circle cx="9" cy="16" r="5" fill="#1b1240" stroke="#b9a8f6" stroke-width="1.6"/>' +
    '</svg>'
]

/** A short gold streak left behind while the hold star follows the pointer. */
export function burstMitiaGoldTrail(x: number, y: number): void {
  const layer = mitiaLayer()
  const el = document.createElement('span')
  el.className = 'mitia-gold-trail'
  el.style.left = `${x}px`
  el.style.top = `${y}px`
  layer.appendChild(el)
  window.setTimeout(() => el.remove(), 650)
}

/**
 * Continuous gold ribbon behind the hold star.
 *
 * This is a single SVG polyline (one vector stroke), not a canvas: canvas
 * strokes add their alpha on every segment and leave the crossed area looking
 * brighter. A single path can never exceed its own stroke opacity.
 */
export function startMitiaGoldTrail(): {
  push: (x: number, y: number) => void
  stop: () => void
} {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('class', 'mitia-gold-trail-svg')
  // Gold-purple gradient that follows the recent direction of the trail.
  const defs = document.createElementNS(ns, 'defs')
  const grad = document.createElementNS(ns, 'linearGradient')
  grad.setAttribute('id', 'mitia-trail-grad')
  grad.setAttribute('gradientUnits', 'userSpaceOnUse')
  for (const [offset, color] of [
    ['0', '#ffeec2'],
    ['0.45', '#e8c87a'],
    ['1', '#a78bfa']
  ] as const) {
    const stop = document.createElementNS(ns, 'stop')
    stop.setAttribute('offset', offset)
    stop.setAttribute('stop-color', color)
    grad.appendChild(stop)
  }
  defs.appendChild(grad)
  svg.appendChild(defs)
  const line = document.createElementNS(ns, 'polyline')
  line.setAttribute('fill', 'none')
  line.setAttribute('stroke', 'url(#mitia-trail-grad)')
  line.setAttribute('stroke-width', '2')
  line.setAttribute('stroke-linecap', 'round')
  line.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(line)
  document.body.appendChild(svg)
  const points: string[] = []
  let fadeTimer = 0
  const scheduleFade = (): void => {
    window.clearTimeout(fadeTimer)
    fadeTimer = window.setTimeout(() => {
      svg.style.opacity = '0'
    }, 220)
  }
  return {
    push: (x, y): void => {
      points.push(`${Math.round(x)},${Math.round(y)}`)
      // Keep only the recent tail of the path.
      if (points.length > 36) points.shift()
      line.setAttribute('points', points.join(' '))
      // Tail (oldest) is violet, head (newest) is gold.
      const [tx, ty] = points[0].split(',')
      const [hx, hy] = points[points.length - 1].split(',')
      grad.setAttribute('x1', tx)
      grad.setAttribute('y1', ty)
      grad.setAttribute('x2', hx)
      grad.setAttribute('y2', hy)
      svg.style.opacity = '1'
      scheduleFade()
    },
    stop: (): void => {
      window.clearTimeout(fadeTimer)
      svg.style.opacity = '0'
      window.setTimeout(() => svg.remove(), 260)
    }
  }
}

/**
 * 星轨 molecules flying out of a point (half the material's node size).
 * Used by the click effect and by the games-bar expand / collapse trail.
 */
export function burstMitiaMolecules(
  x: number,
  y: number,
  options: { count?: number; distance?: number } = {}
): void {
  const layer = mitiaLayer()
  const count = options.count ?? 5
  const distance = options.distance ?? 96
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2
    const travel = distance * (0.55 + Math.random() * 0.85)
    const el = document.createElement('span')
    el.className = 'mitia-burst-molecule'
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    el.style.setProperty('--dx', `${Math.cos(angle) * travel}px`)
    el.style.setProperty('--dy', `${Math.sin(angle) * travel}px`)
    el.style.setProperty('--rot', `${Math.round((Math.random() * 2 - 1) * 160)}deg`)
    el.innerHTML = MOLECULE_SVGS[Math.floor(Math.random() * MOLECULE_SVGS.length)]
    layer.appendChild(el)
    window.setTimeout(() => el.remove(), 1100)
  }
}

/**
 * Mitia click effect: a cross star pops open with a slow swallow/spit tremor,
 * follows the pointer while held, and spits molecules out of its centre.
 * The star appears once at the start and only fades after release.
 */
export function startMitiaHoldStar(
  x: number,
  y: number
): { move: (x: number, y: number) => void; stop: () => void } {
  const layer = mitiaLayer()
  const star = document.createElement('span')
  star.className = 'mitia-hold-star'
  star.style.left = `${x}px`
  star.style.top = `${y}px`
  star.innerHTML =
    `<svg viewBox="0 0 100 100" width="76" height="76">` +
    `<defs><linearGradient id="mitia-hold-flow" gradientUnits="userSpaceOnUse" x1="-120" y1="0" x2="-40" y2="0">` +
    `<stop offset="0" stop-color="#e8c87a" stop-opacity="0"/>` +
    `<stop offset="0.5" stop-color="#fff3cf" stop-opacity="0.95"/>` +
    `<stop offset="1" stop-color="#e8c87a" stop-opacity="0"/>` +
    `<animate attributeName="x1" values="-120;140" dur="3.6s" repeatCount="indefinite"/>` +
    `<animate attributeName="x2" values="-40;220" dur="3.6s" repeatCount="indefinite"/>` +
    `</linearGradient></defs>` +
    `<path d="${MITIA_STAR_PATH}" fill="#241a52" stroke="#c9bff2" stroke-width="1.1"/>` +
    `<path d="${MITIA_STAR_PATH}" fill="none" stroke="url(#mitia-hold-flow)" stroke-width="1.1" stroke-linejoin="round"/>` +
    `</svg>`
  layer.appendChild(star)
  let px = x
  let py = y
  // Keep spitting molecules while the pointer is held down.
  const timer = window.setInterval(() => {
    burstMitiaMolecules(px, py, { count: 1, distance: 80 + Math.random() * 50 })
  }, 280)
  const started = performance.now()
  let stopped = false
  const trail = startMitiaGoldTrail()
  return {
    move: (nx, ny): void => {
      px = nx
      py = ny
      star.style.left = `${nx}px`
      star.style.top = `${ny}px`
      trail.push(nx, ny)
    },
    stop: (): void => {
      if (stopped) return
      stopped = true
      window.clearInterval(timer)
      trail.stop()
      // A very short click still shows the star for a moment.
      const wait = Math.max(0, 380 - (performance.now() - started))
      window.setTimeout(() => {
        star.classList.add('out')
        window.setTimeout(() => star.remove(), 240)
      }, wait)
    }
  }
}
