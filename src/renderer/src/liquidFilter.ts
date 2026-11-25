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

export interface LiquidMaps {
  dispHref: string
  specHref: string
  maxDisp: number
}

export function liquidMapInputs(options: LiquidFilterOptions, pixelRatio: number) {
  const {
    width, height, radius, glassThickness = 40, bezelWidth = 16, refractiveIndex = 1.5,
    highlightAngle = 60, sampleScale
  } = options
  const dpr = sampleScale ?? Math.min(Math.max(1, pixelRatio), MAX_MAP_SIDE / Math.max(width, height, 1))
  const geometryKey = JSON.stringify([width, height, radius, dpr])
  return {
    width, height, radius, glassThickness, bezelWidth, refractiveIndex, dpr,
    angle: highlightAngle * Math.PI / 180,
    displacementKey: JSON.stringify([geometryKey, bezelWidth, glassThickness, refractiveIndex]),
    specularKey: JSON.stringify([geometryKey, highlightAngle])
  }
}

/** Force the alpha to 1 (used after the screen-blended dispersion passes). */
const OPAQUE_MATRIX = '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 0 1'
const R_ONLY = '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0'
const G_ONLY = '0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0'
const B_ONLY = '0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0'

export function buildLiquidFilter(id: string, options: LiquidFilterOptions, maps: LiquidMaps): string {
  const {
    width,
    height,
    blur = 0,
    refraction = 1,
    highlight = 0.4,
    dispersion = 0,
    specularSaturation = 4,
    maxScale
  } = options

  const { dispHref, specHref, maxDisp } = maps
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
