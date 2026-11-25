import {
  DEFAULT_GLASS_APPEARANCE,
  MATERIAL_DEFAULTS,
  type GlassAppearance,
  type GlassMaterial,
  type GlassPatch
} from '@shared/types'

/**
 * Valid glass materials, derived from the material-preset registry. Deriving
 * (instead of keeping a second hard-coded list) is what guarantees that a new
 * material can be picked in the settings **and** stored by the main process.
 */
export const GLASS_MATERIALS = Object.keys(MATERIAL_DEFAULTS) as GlassMaterial[]

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.round(value) || 0))

/** Merge a patch over the (default-filled) current glass appearance, clamping. */
export function mergeGlass(
  current: Partial<GlassAppearance> | undefined,
  patch: GlassPatch
): GlassAppearance {
  const base = { ...DEFAULT_GLASS_APPEARANCE, ...current }
  const pick = (value: number | undefined, lo: number, hi: number, fallback: number): number =>
    value != null ? clamp(value, lo, hi) : fallback
  const material =
    patch.material && GLASS_MATERIALS.includes(patch.material) ? patch.material : base.material
  return {
    brightness: pick(patch.brightness, 0, 100, base.brightness),
    opacity: pick(patch.opacity, 0, 100, base.opacity),
    material,
    blur: pick(patch.blur, 0, 60, base.blur),
    saturation: pick(patch.saturation, 50, 200, base.saturation),
    grain: pick(patch.grain, 0, 100, base.grain),
    refraction: pick(patch.refraction, 0, 200, base.refraction),
    panelRefraction: pick(patch.panelRefraction, 0, 200, base.panelRefraction),
    edgeWidth: pick(patch.edgeWidth, 4, 100, base.edgeWidth),
    highlight: pick(patch.highlight, 0, 100, base.highlight),
    highlightAngle: pick(patch.highlightAngle, 0, 360, base.highlightAngle),
    dispersion: pick(patch.dispersion, 0, 100, base.dispersion)
  }
}
