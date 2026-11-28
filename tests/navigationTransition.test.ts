import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  new URL('../src/renderer/src/assets/main.css', import.meta.url),
  'utf8'
)

function topLevelRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^{}]*)\\}`).exec(css)?.[1] ?? ''
}

describe('navigation transition', () => {
  it('slides only the stage, leaving the fixed glass layers out of the animation', () => {
    // A transform on `.app-anim` promotes its fixed rail/topbar and every
    // backdrop-filter surface, which is what flashed the whole window grey.
    expect(topLevelRule('.app-anim')).not.toMatch(/\b(animation|transform|filter|opacity)\b/)
    expect(topLevelRule('.app-anim-run')).toBe('')
    expect(topLevelRule('.app-anim-run .stage')).toContain('animation: appIn')
    expect(css.match(/animation:\s*appIn\b/g)).toHaveLength(1)
    expect(css).not.toContain('appCounter')
  })

  it('keeps the themed stage slides so their text sweep still starts', () => {
    for (const [theme, animation] of [
      ['starsnow', 'sn-page-in'],
      ['mitia', 'mt-page-in']
    ] as const) {
      expect(css).toMatch(
        new RegExp(
          `\\[data-special-transition='${theme}'\\] \\.app-anim-run \\.stage\\s*\\{\\s*animation:\\s*${animation}`
        )
      )
      expect(css).toMatch(
        new RegExp(
          `\\[data-special-transition='${theme}'\\] \\.app-anim-run\\s*\\{\\s*animation:\\s*none;`
        )
      )
    }
  })

  it('lets a one-shot page switch finish while decorative motion is paused', () => {
    expect(css).toMatch(
      /\[data-visual-paused\] \.app-anim-run \.stage,[\s\S]*?animation-play-state: running !important;/
    )
    expect(css).toContain('[data-visual-paused] .app-anim-run .page-curve,')
    expect(css).toContain('[data-visual-paused] .app-anim-run .page-header::after {')
  })

  it('honours reduced motion without leaving a themed wipe on screen', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.app-anim-run \.stage,/)
    expect(reduced).toMatch(/\[data-special-transition='starsnow'\] \.app-anim-run \.stage,/)
    expect(reduced).toMatch(/\[data-special-transition='mitia'\] \.app-anim-run \.stage\s*\{/)
    expect(reduced).toMatch(/\.app-anim-run::after\s*\{[\s\S]*?display: none;/)
  })
})
