/**
 * Liquid-glass displacement maps — ported verbatim from the reference
 * implementation behind https://liunian.js.org/posts/liquid-glass/ (its
 * `gu`/`yu`/`xu`/`vu` helpers and `Filter` component).
 *
 * A "bezel" height profile (`buildBezelProfile`) is computed for the chosen
 * glass thickness / bezel width / refractive index; the displacement map
 * (`buildDisplacementBytes`) encodes, for every pixel inside the bezel band, the
 * refracted normal direction (R = x, G = y, 128 = neutral) and `buildSpecularBytes`
 * produces the rim highlight layer. The SVG filter graph that consumes these is
 * built in `liquidFilter.ts`.
 *
 * The map builders are pure (return raw RGBA bytes) so they can be unit-tested
 * without a DOM; `bytesToDataUrl` is the only renderer-only helper.
 */

/** Height profile of the bezel edge (the reference `Tu.fn`, a squircle ease). */
export const DEFAULT_BEZEL_HEIGHT_FN = (t: number): number =>
  Math.pow(1 - Math.pow(1 - t, 4), 1 / 4)

/** Sampling resolution of the bezel height profile. */
const PROFILE_SAMPLES = 128

/**
 * The reference `gu`: samples the bezel height profile and, for each sample,
 * refracts the surface normal through the glass to get a displacement magnitude.
 */
export function buildBezelProfile(
  glassThickness: number,
  bezelWidth: number,
  bezelHeightFn: (t: number) => number = DEFAULT_BEZEL_HEIGHT_FN,
  refractiveIndex = 1.5
): number[] {
  const inv = 1 / refractiveIndex
  const refract = (nx: number, ny: number): [number, number] | null => {
    const u = ny
    const c = 1 - inv * inv * (1 - u * u)
    if (c < 0) return null
    const s = Math.sqrt(c)
    return [-(inv * u + s) * nx, inv - (inv * u + s) * ny]
  }
  return Array.from({ length: PROFILE_SAMPLES }, (_, l) => {
    const u = l / PROFILE_SAMPLES
    const h0 = bezelHeightFn(u)
    const h = u < 1 ? 1e-4 : -1e-4
    const d = (bezelHeightFn(u + h) - h0) / h
    const m = Math.sqrt(d * d + 1)
    const v = refract(-d / m, -1 / m)
    if (!v) return 0
    const x = h0 * bezelWidth + glassThickness
    return v[0] * (x / v[1])
  })
}

/** Fill an RGBA byte buffer with the neutral displacement value (128, 128, 0, 255). */
function neutralBytes(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 128
    data[i + 1] = 128
    data[i + 2] = 0
    data[i + 3] = 255
  }
  return data
}

/** Signed distance to the (rounded) rectangle: negative inside, 0 on the edge. */
function roundRectDistance(
  x: number,
  y: number,
  hw: number,
  hh: number,
  r: number
): number {
  const qx = Math.abs(x - hw) - (hw - r)
  const qy = Math.abs(y - hh) - (hh - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

/**
 * The edge-bulge displacement map, expressed as the distance to the shape's edge
 * (a rounded-rect SDF). The refracting band spans `bezelWidth` px inward from the
 * edge **regardless of the corner radius** — so the material's edge width is a
 * pure material parameter (never clamped by layout), it never steps, and any
 * value stays effective. Interior keeps the neutral 128.
 */
export function buildDisplacementBytes(
  width: number,
  height: number,
  radius: number,
  bezelWidth: number,
  maxDisplacement: number,
  profile: number[],
  dpr = 1
): Uint8ClampedArray {
  const c = Math.max(1, Math.round(width * dpr))
  const h = Math.max(1, Math.round(height * dpr))
  const data = neutralBytes(c, h)
  if (maxDisplacement <= 0 || bezelWidth <= 0) return data

  const hw = c / 2
  const hh = h / 2
  const r = Math.min(Math.max(0, radius) * dpr, hw, hh)
  const band = Math.max(0.5, bezelWidth * dpr)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < c; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const inside = -roundRectDistance(px, py, hw, hh, r) // distance to the edge (inside)
      if (inside <= 0 || inside > band) continue
      // Numeric gradient of the SDF → outward normal.
      const e = 0.75
      const gx =
        roundRectDistance(px + e, py, hw, hh, r) - roundRectDistance(px - e, py, hw, hh, r)
      const gy =
        roundRectDistance(px, py + e, hw, hh, r) - roundRectDistance(px, py - e, hw, hh, r)
      const gl = Math.hypot(gx, gy) || 1
      const nx = gx / gl
      const ny = gy / gl
      const t = Math.min(1, inside / band)
      const idx = Math.min(profile.length - 1, Math.max(0, Math.round(t * (profile.length - 1))))
      const mag = profile[idx] / maxDisplacement
      if (mag === 0) continue
      const falloff = Math.min(1, inside / 1.2)
      const o = (y * c + x) * 4
      data[o] = 128 + -nx * mag * 127 * falloff
      data[o + 1] = 128 + -ny * mag * 127 * falloff
      data[o + 2] = 0
      data[o + 3] = 255
    }
  }
  return data
}

/**
 * The reference `xu`: the rim specular/highlight layer. Alpha marks where the
 * highlight sits (its brightness tapers with a light-direction dot product run
 * through a squircle ease).
 */
export function buildSpecularBytes(
  width: number,
  height: number,
  radius: number,
  softness: number,
  angle: number = Math.PI / 3,
  dpr = 1
): Uint8ClampedArray {
  const a = Math.round(width * dpr)
  const l = Math.round(height * dpr)
  const data = new Uint8ClampedArray(a * l * 4)
  const c = radius * dpr
  const h = softness * dpr
  const [lx, ly] = [Math.cos(angle), Math.sin(angle)]
  const m = c * c
  const outer2 = (c + dpr) * (c + dpr)
  const inner2 = (c - h) * (c - h)
  const g = a - c * 2
  const x = l - c * 2
  for (let row = 0; row < l; row++) {
    for (let col = 0; col < a; col++) {
      const left = col < c
      const right = col >= a - c
      const top = row < c
      const bottom = row >= l - c
      const dx = left ? col - c : right ? col - c - g : 0
      const dy = top ? row - c : bottom ? row - c - x : 0
      const dist2 = dx * dx + dy * dy
      if (dist2 > outer2 || dist2 < inner2) continue
      const dist = Math.sqrt(dist2)
      const tall = dist2 < m ? 1 : 1 - (dist - Math.sqrt(m)) / (Math.sqrt(outer2) - Math.sqrt(m))
      const nx = dx / dist
      const ny = -dy / dist
      const dot = Math.abs(nx * lx + ny * ly) * Math.sqrt(1 - Math.pow(1 - (c - dist) / dpr, 2))
      const z = 255 * dot
      const o = (row * a + col) * 4
      data[o] = z
      data[o + 1] = z
      data[o + 2] = z
      data[o + 3] = z * dot * tall
    }
  }
  return data
}

/** The reference `vu`: a radial magnifying displacement map (optional feature). */
export function buildMagnifyingBytes(width: number, height: number, dpr = 1): Uint8ClampedArray {
  const w = Math.round(width * dpr)
  const h = Math.round(height * dpr)
  const data = new Uint8ClampedArray(w * h * 4)
  const r = Math.max(w / 2, h / 2)
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const o = (row * w + col) * 4
      const nx = (col - w / 2) / r
      const ny = (row - h / 2) / r
      data[o] = 128 - nx * 127
      data[o + 1] = 128 - ny * 127
      data[o + 2] = 0
      data[o + 3] = 255
    }
  }
  return data
}

/** Render raw RGBA bytes to a PNG data URI (renderer only). */
export function bytesToDataUrl(bytes: Uint8ClampedArray, width: number, height: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const image = ctx.createImageData(width, height)
  image.data.set(bytes)
  ctx.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
}
