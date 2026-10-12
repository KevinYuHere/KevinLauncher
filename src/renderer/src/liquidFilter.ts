/**
 * Builds the reference SVG `backdrop-filter` graph
 * (https://liunian.js.org/posts/liquid-glass/) as a markup string, extended with
 * the chromatic dispersion from
 * https://forum.cocos.org/t/topic/171941 (R/B sampled along ±the refraction
 * vector, G in the middle).
 *
 * The two maps only depend on the surface geometry (not on the material, blur or
 * colour scheme), so they are cached by geometry — changing refraction /
 * highlight / dispersion / blur is then just a cheap markup rebuild.
 */
import {
  buildBezelProfile,
  buildDisplacementBytes,
  buildSpecularBytes,
  bytesToDataUrl,
  DEFAULT_BEZEL_HEIGHT_FN
} from './liquidGlass'

export interface LiquidFilterOptions {
  width: number
  height: number
  radius: number
  /** Backdrop blur in px (feGaussianBlur stdDeviation). */
  blur?: number
  glassThickness?: number
  bezelWidth?: number
  refractiveIndex?: number
  /** Refraction strength ratio (the reference `scaleRatio`); 1 = default. */
  refraction?: number
  /** Rim highlight opacity 0..1. */
  highlight?: number
  /** Rim highlight light angle in degrees. */
  highlightAngle?: number
  /** Chromatic dispersion 0..1 (0 = off). */
  dispersion?: number
  specularSaturation?: number
  /** Hard cap on the displacement scale (px) — keeps huge panels readable. */
  maxScale?: number
  /** 0..1 map resolution scale (1 = native). */
  sampleScale?: number
}

/** Largest map side (px); bigger surfaces are sampled at a lower resolution. */
const MAX_MAP_SIDE = 400
const MAP_CACHE_LIMIT = 96

interface Maps {
  dispHref: string
  specHref: string
  maxDisp: number
}

const mapCache = new Map<string, Maps>()

function resolveDpr(width: number, height: number, sampleScale?: number): number {
  const native = Math.max(1, window.devicePixelRatio || 1)
  return sampleScale ?? Math.min(native, MAX_MAP_SIDE / Math.max(width, height, 1))
}

function getMaps(
  width: number,
  height: number,
  radius: number,
  bezelWidth: number,
  glassThickness: number,
  refractiveIndex: number,
  angle: number,
  dpr: number
): Maps {
  const key = `${Math.round(width)}x${Math.round(height)}x${radius}x${bezelWidth}x${glassThickness}x${refractiveIndex}x${angle.toFixed(2)}x${dpr.toFixed(3)}`
  const cached = mapCache.get(key)
  if (cached) return cached

  const cw = Math.max(1, Math.round(width * dpr))
  const ch = Math.max(1, Math.round(height * dpr))
  // The band width is purely the material's edge width (independent of layout).
  const profile = buildBezelProfile(
    glassThickness,
    bezelWidth,
    DEFAULT_BEZEL_HEIGHT_FN,
    refractiveIndex
  )
  let maxDisp = 0
  for (const v of profile) maxDisp = Math.max(maxDisp, Math.abs(v))
  maxDisp = Math.max(maxDisp, 1e-6)

  const maps: Maps = {
    dispHref: bytesToDataUrl(
      buildDisplacementBytes(width, height, radius, bezelWidth, maxDisp, profile, dpr),
      cw,
      ch
    ),
    // The specular band scales with the corner radius (a fixed size would leave
    // small corners with no rim).
    specHref: bytesToDataUrl(
      buildSpecularBytes(width, height, radius, Math.max(8, radius * 1.1), angle, dpr),
      cw,
      ch
    ),
    maxDisp
  }
  if (mapCache.size >= MAP_CACHE_LIMIT) mapCache.clear()
  mapCache.set(key, maps)
  return maps
}

/** Force the alpha to 1 (used after the screen-blended dispersion passes). */
const OPAQUE_MATRIX = '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 0 1'
const R_ONLY = '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0'
const G_ONLY = '0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0'
const B_ONLY = '0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0'

export function buildLiquidFilter(id: string, options: LiquidFilterOptions): string {
  const {
    width,
    height,
    radius,
    blur = 0,
    glassThickness = 40,
    bezelWidth = 16,
    refractiveIndex = 1.5,
    refraction = 1,
    highlight = 0.4,
    highlightAngle = 60,
    dispersion = 0,
    specularSaturation = 4,
    maxScale,
    sampleScale
  } = options

  const dpr = resolveDpr(width, height, sampleScale)
  const angle = (highlightAngle * Math.PI) / 180
  const { dispHref, specHref, maxDisp } = getMaps(
    width,
    height,
    radius,
    bezelWidth,
    glassThickness,
    refractiveIndex,
    angle,
    dpr
  )
  const scale = maxScale != null ? Math.min(maxDisp * refraction, maxScale) : maxDisp * refraction

  const displacement =
    dispersion > 0
      ? (() => {
          const d = dispersion
          const sR = scale * (1 + d)
          const sG = scale
          const sB = scale * (1 - d)
          return (
            `<feDisplacementMap in="blurred_source" in2="displacement_map" scale="${sR}" xChannelSelector="R" yChannelSelector="G" result="disp_r"/>` +
            `<feDisplacementMap in="blurred_source" in2="displacement_map" scale="${sG}" xChannelSelector="R" yChannelSelector="G" result="disp_g"/>` +
            `<feDisplacementMap in="blurred_source" in2="displacement_map" scale="${sB}" xChannelSelector="R" yChannelSelector="G" result="disp_b"/>` +
            `<feColorMatrix in="disp_r" type="matrix" values="${R_ONLY}" result="ch_r"/>` +
            `<feColorMatrix in="disp_g" type="matrix" values="${G_ONLY}" result="ch_g"/>` +
            `<feColorMatrix in="disp_b" type="matrix" values="${B_ONLY}" result="ch_b"/>` +
            `<feBlend in="ch_g" in2="ch_b" mode="screen" result="ch_gb"/>` +
            `<feBlend in="ch_r" in2="ch_gb" mode="screen" result="dispersed"/>` +
            `<feColorMatrix in="dispersed" type="matrix" values="${OPAQUE_MATRIX}" result="displaced"/>`
          )
        })()
      : `<feDisplacementMap in="blurred_source" in2="displacement_map" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="displaced"/>`

  return (
    `<filter id="${id}" color-interpolation-filters="sRGB">` +
    `<feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" result="blurred_source"/>` +
    `<feImage href="${dispHref}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none" result="displacement_map"/>` +
    displacement +
    `<feColorMatrix in="displaced" type="saturate" values="${specularSaturation}" result="displaced_saturated"/>` +
    `<feImage href="${specHref}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none" result="specular_layer"/>` +
    `<feComposite in="displaced_saturated" in2="specular_layer" operator="in" result="specular_saturated"/>` +
    `<feComponentTransfer in="specular_layer" result="specular_faded"><feFuncA type="linear" slope="${highlight}"/></feComponentTransfer>` +
    `<feBlend in="specular_saturated" in2="displaced" mode="normal" result="withSaturation"/>` +
    `<feBlend in="specular_faded" in2="withSaturation" mode="normal"/>` +
    `</filter>`
  )
}
