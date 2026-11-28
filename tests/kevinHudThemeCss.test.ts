import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readAsset = (name: string): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets', name), 'utf8')

/** The theme overrides sit together just before the responsive rules. */
function themeBlock(css: string, selector: string): string {
  const start = css.indexOf(selector)
  expect(start).toBeGreaterThan(-1)
  const fromSelector = css.slice(start)
  const end = fromSelector.indexOf('@media (max-width: 760px)')
  return end === -1 ? fromSelector : fromSelector.slice(0, end)
}

const settingsCss = readAsset('kevin-hud-settings.css')
const gradientCss = readAsset('kevin-hud-gradient.css')

describe('KEVIN HUD settings 星轨手记 geometry', () => {
  it('squares the HUD-only rectangles while default radii stay untouched', () => {
    const scoped = themeBlock(settingsCss, "[data-special-theme~='mitia'] :is(")
    for (const control of [
      '.kh-mark',
      '.kh-fresh',
      '.kh-notice',
      '.kh-size-note',
      '.kh-style-badge',
      '.kh-metric-row',
      '.kh-style-default-head',
      '.kh-style-reserve',
      '.kh-style-drawer',
      '.kh-copy-head',
      '.kh-copy-body',
      '.kh-copy .collapse-head',
      '.kh-metric-stack .collapse-head',
      '.kh-style-default .collapse-head'
    ]) {
      expect(scoped).toContain(control)
    }
    expect(scoped).toContain('border-radius: 0 !important')
    // Only geometry changes here: no extra paint or motion work.
    expect(scoped).not.toMatch(/\b(?:background|box-shadow|filter|animation)\s*:/)

    // The stock theme still gets its original radii.
    expect(settingsCss).toMatch(/\.kh-notice\s*\{[^}]*border-radius: 0 8px 8px 0;/s)
    expect(settingsCss).toMatch(/\.kh-metric-row\s*\{[^}]*border-radius: 9px;/s)
    expect(settingsCss).toMatch(/\.kh-copy-head\s*\{[^}]*border-radius: 9px;/s)
    expect(settingsCss).toMatch(/\.kh-fresh\s*\{[^}]*border-radius: 999px;/s)
  })

  it('squares colour-picker children but keeps the point markers round', () => {
    const scoped = themeBlock(settingsCss, "[data-special-theme~='mitia'] .kh-card :is(")
    for (const control of [
      '.kh-color-swatch',
      '.color-editor .react-colorful',
      '.color-editor .react-colorful__saturation',
      '.color-editor .react-colorful__hue',
      '.color-preview',
      '.color-swatch'
    ]) {
      expect(scoped).toContain(control)
    }
    expect(scoped).toContain('border-radius: 0 !important')
    expect(scoped).not.toContain('.react-colorful__pointer')
    expect(settingsCss).not.toContain("[data-special-theme~='mitia'] .kh-live-dot")
    expect(settingsCss).toMatch(/\.kh-live-dot\s*\{[^}]*border-radius: 50%;/s)
  })

  it('squares the gradient editor chrome without touching the centre pin', () => {
    const scoped = themeBlock(gradientCss, "[data-special-theme~='mitia'] :is(")
    for (const control of [
      '.khg-editor',
      '.khg-preview',
      '.khg-stop .collapse-head',
      '.khg-stop-head',
      '.khg-color-panel',
      '.khg-swatch'
    ]) {
      expect(scoped).toContain(control)
    }
    expect(scoped).toContain('border-radius: 0 !important')
    expect(scoped).not.toMatch(/\b(?:background|box-shadow|filter|animation)\s*:/)
    expect(scoped).not.toContain('.khg-preview-pin')
    expect(gradientCss).toMatch(/\.khg-preview\s*\{[^}]*border-radius: 10px;/s)
    expect(gradientCss).toMatch(/\.khg-preview-pin\s*\{[^}]*border-radius: 50%;/s)

    // The quiet pastel "new feature" sheen and adaptive glass fills stay intact.
    expect(settingsCss).toContain('#93c5fd')
    expect(settingsCss).toContain('#c4b5fd')
    expect(settingsCss).toContain('#f9a8d4')
    expect(settingsCss).toContain('animation: btnFlow 5.2s var(--ease) infinite')
    expect(settingsCss).not.toContain('@keyframes kh-fresh')
    expect(settingsCss).toContain('background: var(--field-bg)')
    expect(gradientCss).toContain('background-color: var(--field-bg)')
  })
})
