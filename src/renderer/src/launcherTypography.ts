import {
  LAUNCHER_FONT_FACE_STYLE_ID,
  launcherFontFaceCss,
  launcherFontStack,
  resolveLauncherFonts,
  type LauncherFontSource
} from '@shared/launcherFonts'
import type { LauncherFontSelection } from '@shared/types'

/**
 * Install the effective launcher typography into one document.
 *
 * The helper is document-scoped on purpose: the launcher window calls it for
 * `document`, and the independent KEVIN HUD page can call the very same helper
 * for its own `document` without sharing globals or CSS. It only writes a
 * single controlled `<style>` node plus the existing `--app-font` custom
 * property, so any CSS that already reads `var(--app-font)` adopts it.
 */
const applied = new WeakMap<Document, string>()

const fontKey = (fonts: LauncherFontSelection): string =>
  `${fonts.en ?? ''}\u0000${fonts.zh ?? ''}`

/**
 * Resolve and apply per-script families. Accepts either persisted launcher
 * settings (`fontFamily`, `fontFamilyEn`, `fontFamilyZh`), a HUD frame (same
 * fields, optional additions) or an already-resolved `{ en, zh }`.
 *
 * Returns the effective selection. Repeat calls with the same values are a
 * no-op, including across React re-renders.
 */
export function applyLauncherTypography(
  doc: Document,
  source: LauncherFontSource | LauncherFontSelection | null | undefined
): LauncherFontSelection {
  const fonts = resolveLauncherFonts(source)
  const root = doc.documentElement
  if (!root) return fonts

  const key = fontKey(fonts)
  const existing = doc.getElementById(LAUNCHER_FONT_FACE_STYLE_ID)
  if (applied.get(doc) === key && existing?.isConnected) return fonts

  const css = launcherFontFaceCss(fonts)
  let style: HTMLStyleElement | null = null
  if (existing) {
    if (existing.tagName === 'STYLE') {
      style = existing as HTMLStyleElement
    } else {
      existing.remove()
    }
  }

  if (css) {
    if (!style) {
      style = doc.createElement('style')
      style.id = LAUNCHER_FONT_FACE_STYLE_ID
      // The rules contain only fixed declarations plus CSS-escaped font names.
      const container = doc.head ?? root
      container.appendChild(style)
    }
    if (style.textContent !== css) style.textContent = css
  } else {
    style?.remove()
  }

  root.style.setProperty('--app-font', launcherFontStack(fonts))
  applied.set(doc, key)
  return fonts
}
