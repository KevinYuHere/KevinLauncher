import {
  SPECIAL_AREAS,
  resolveAreaTheme,
  specialThemeDefinition,
  type ThemeAssignments
} from '@shared/specialTheme'
import type { SpecialThemeId } from '@shared/types'

const TOKEN_PROPERTIES = new Set<string>()

/**
 * Write one `data-special-<area>="<themeId>"` attribute per themed surface, plus
 * the active theme's tokens / motion families on `<html>`. CSS (and only CSS)
 * decides what each area looks like, so adding a theme or an area never needs a
 * component change.
 */
export function applySpecialTheme(assignments: ThemeAssignments | undefined): void {
  const root = document.documentElement
  const active = new Set<SpecialThemeId>()
  for (const area of SPECIAL_AREAS) {
    const themeId = resolveAreaTheme(assignments, area.id)
    const key = area.id.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
    if (themeId !== 'default') {
      root.setAttribute('data-special-' + key, themeId)
      active.add(themeId)
    } else {
      root.removeAttribute('data-special-' + key)
    }
  }

  // Tokens / motion hooks are only meaningful while a theme is in use. Applying
  // them to `<html>` is safe: every themed rule is namespaced under its area,
  // so untouched areas keep using the ordinary glass tokens.
  const ids = [...active]
  if (ids.length > 0) root.dataset.specialTheme = ids.join(' ')
  else delete root.dataset.specialTheme

  for (const id of [...TOKEN_PROPERTIES]) root.style.removeProperty(id)
  TOKEN_PROPERTIES.clear()
  const motionKeys = ['jelly', 'dialogIn', 'dialogOut', 'popupIn', 'popupOut', 'page', 'toast']
  for (const key of motionKeys) delete root.dataset[`motion${key[0].toUpperCase()}${key.slice(1)}`]

  const definition = ids
    .map((id) => specialThemeDefinition(id))
    .find((theme) => theme.id !== 'default')
  if (!definition) return
  for (const [property, value] of Object.entries(definition.tokens)) {
    root.style.setProperty(property, value)
    TOKEN_PROPERTIES.add(property)
  }
  for (const [key, value] of Object.entries(definition.motion)) {
    root.dataset[`motion${key[0].toUpperCase()}${key.slice(1)}`] = value
  }
}
