import type { LauncherFontSelection } from './types'

/**
 * Typography shared by the launcher UI and its independent HUD document.
 *
 * A plain `font-family` list cannot keep scripts independent: if the chosen
 * English font also contains Han glyphs (or the chosen Chinese font contains
 * Latin glyphs), whichever family comes first wins for the whole mixed string.
 * We therefore alias each selection through a controlled `@font-face` with a
 * fixed `unicode-range`, so Latin/digits always use the English face and CJK
 * always uses the Chinese face even when both fonts contain both scripts.
 *
 * This module is deliberately DOM-free. It only normalizes persisted values and
 * builds the small, fixed CSS/stack; renderers install it through
 * `renderer/src/launcherTypography.ts`. No caller-provided CSS is passed through.
 */

/** At most this many characters from an enumerated family name are kept. */
export const MAX_LAUNCHER_FONT_LENGTH = 128

/** Alias families owned by the launcher; never raw user font names. */
export const LAUNCHER_FONT_LATIN_FAMILY = 'KevinLauncher Latin'
export const LAUNCHER_FONT_CJK_FAMILY = 'KevinLauncher CJK'

/** Style element used by the renderer helper to install the two faces. */
export const LAUNCHER_FONT_FACE_STYLE_ID = 'kevin-launcher-font-faces'

/**
 * Latin/digits/English punctuation. CJK ranges are intentionally disjoint so a
 * font that contains both scripts cannot claim the other script's text.
 */
export const LAUNCHER_FONT_LATIN_RANGE = [
  'U+0000-024F',
  'U+0250-02AF',
  'U+02B0-02FF',
  'U+0300-036F',
  'U+1D00-1DFF',
  'U+1E00-1EFF',
  'U+2000-206F',
  'U+2070-209F',
  'U+20A0-20CF',
  'U+2100-214F',
  'U+2150-218F',
  'U+2C60-2C7F',
  'U+A720-A7FF',
  'U+FB00-FB06',
  'U+FE00-FE0F'
].join(', ')

/** Chinese characters, CJK punctuation, radicals and full-width forms. */
export const LAUNCHER_FONT_CJK_RANGE = [
  'U+2E80-2EFF',
  'U+2F00-2FDF',
  'U+3000-303F',
  'U+3040-30FF',
  'U+3100-312F',
  'U+31A0-31BF',
  'U+31C0-31EF',
  'U+3200-32FF',
  'U+3300-33FF',
  'U+3400-4DBF',
  'U+4E00-9FFF',
  'U+F900-FAFF',
  'U+FE10-FE1F',
  'U+FE30-FE4F',
  'U+FF00-FFEF',
  'U+20000-2FA1F',
  'U+30000-323AF'
].join(', ')

/** Launcher system fallback; also used when one or both selections are reset. */
export const LAUNCHER_FONT_BASE_STACK =
  '"Segoe UI", "Microsoft YaHei UI", system-ui, -apple-system, sans-serif'

/** A persisted old-style single font plus the newer discrete choices. */
export interface LauncherFontSource {
  fontFamily?: string | null
  fontFamilyEn?: string | null
  fontFamilyZh?: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Keep a real family name and remove characters that cannot be part of a safe
 * `local("…")` string. Quotes/backslashes are escaped later, so names that
 * legitimately contain them still round-trip.
 */
export function normalizeLauncherFontFamily(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const family = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return family ? family.slice(0, MAX_LAUNCHER_FONT_LENGTH) : null
}

/**
 * Effective per-script families.
 *
 * A config written before independent fonts has only `fontFamily`; that single
 * choice maps to both scripts. An individual missing field likewise falls back
 * to the legacy value, while an explicit `null` stays a deliberate reset to the
 * system default. This mirrors how config normalize materializes the new fields.
 */
export function resolveLauncherFonts(
  source: LauncherFontSource | LauncherFontSelection | null | undefined
): LauncherFontSelection {
  if (!isRecord(source)) return { en: null, zh: null }

  // Also accept the already-resolved `{ en, zh }` shape used by renderers.
  if (Object.hasOwn(source, 'en') || Object.hasOwn(source, 'zh')) {
    return {
      en: normalizeLauncherFontFamily(source.en),
      zh: normalizeLauncherFontFamily(source.zh)
    }
  }

  const legacy = normalizeLauncherFontFamily(source.fontFamily)
  return {
    en: Object.hasOwn(source, 'fontFamilyEn')
      ? normalizeLauncherFontFamily(source.fontFamilyEn)
      : legacy,
    zh: Object.hasOwn(source, 'fontFamilyZh')
      ? normalizeLauncherFontFamily(source.fontFamilyZh)
      : legacy
  }
}

/** Normalize an explicit `{ en, zh }` selection (HUD frame/lifecycle input). */
export function normalizeLauncherFontSelection(value: unknown): LauncherFontSelection | null {
  if (!isRecord(value)) return null
  return {
    en: normalizeLauncherFontFamily(value.en),
    zh: normalizeLauncherFontFamily(value.zh)
  }
}

const cssString = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

function fontFace(family: string, localName: string, unicodeRange: string): string {
  return [
    '@font-face {',
    `  font-family: ${cssString(family)};`,
    `  src: local(${cssString(localName)});`,
    `  unicode-range: ${unicodeRange};`,
    '  font-style: normal;',
    '  font-weight: normal;',
    '  font-display: swap;',
    '}'
  ].join('\n')
}

/** Controlled @font-face rules for the selected families (empty when reset). */
export function launcherFontFaceCss(fonts: LauncherFontSelection): string {
  const rules: string[] = []
  if (fonts.en) {
    rules.push(fontFace(LAUNCHER_FONT_LATIN_FAMILY, fonts.en, LAUNCHER_FONT_LATIN_RANGE))
  }
  if (fonts.zh) {
    rules.push(fontFace(LAUNCHER_FONT_CJK_FAMILY, fonts.zh, LAUNCHER_FONT_CJK_RANGE))
  }
  return rules.join('\n')
}

/**
 * `--app-font` value. Alias families are only emitted for scripts that have a
 * selection; both then fall through to the same launcher-wide system stack.
 */
export function launcherFontStack(fonts: LauncherFontSelection): string {
  const families: string[] = []
  if (fonts.en) families.push(cssString(LAUNCHER_FONT_LATIN_FAMILY))
  if (fonts.zh) families.push(cssString(LAUNCHER_FONT_CJK_FAMILY))
  return [...families, LAUNCHER_FONT_BASE_STACK].join(', ')
}
