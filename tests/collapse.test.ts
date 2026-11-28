import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import Collapse from '../src/renderer/src/components/Collapse'

function header(label: string): ReactElement {
  return createElement('div', { className: 'drawer-trigger' }, label)
}

function content(label: string): ReactElement {
  return createElement('div', { className: 'drawer-content' }, label)
}

describe('Collapse headers', () => {
  it('keeps the trigger outside the reveal so a closed drawer can reopen', () => {
    for (const open of [false, true]) {
      const html = renderToStaticMarkup(
        createElement(Collapse, {
          open,
          header: header('打开抽屉'),
          children: content('抽屉内容')
        })
      )

      expect(html).toContain(`class="collapse${open ? ' open' : ''}"`)
      expect(html).toContain('class="collapse-head"')
      expect(html).toContain('class="collapse-reveal"')
      expect(html).toContain(`aria-hidden="${open ? 'false' : 'true'}"`)
      expect(html.indexOf('打开抽屉')).toBeLessThan(html.indexOf('class="collapse-reveal"'))
      expect(html.indexOf('class="collapse-reveal"')).toBeLessThan(html.indexOf('抽屉内容'))
    }
  })

  it('renders nested triggers with their own sticky offset slot', () => {
    const inner = createElement(Collapse, {
      open: true,
      header: header('内层'),
      children: content('内层内容')
    })
    const html = renderToStaticMarkup(
      createElement(Collapse, {
        open: true,
        header: header('外层'),
        children: inner
      })
    )

    expect(html.match(/class="collapse-head"/g)).toHaveLength(2)
    expect(html.match(/--collapse-sticky-top:0px/g)).toHaveLength(2)
    expect(html.indexOf('外层')).toBeLessThan(html.indexOf('内层'))
    expect(html.indexOf('内层')).toBeLessThan(html.indexOf('内层内容'))
  })
})

describe('Collapse sticky CSS chain', () => {
  it('stays sticky inside the page scroller instead of stopping at a card wrapper', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/assets/main.css'), 'utf8')
    const headerRule = css.match(/\.collapse\.open > \.collapse-head \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const revealRule = css.match(/\.collapse-reveal \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const innerRule = css.match(/\.collapse-inner \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const settingsRule = css.match(/^\.settings \{([\s\S]*?)\n\}/m)?.[1] ?? ''

    expect(headerRule).toContain('position: sticky')
    expect(headerRule).toContain('top: var(--collapse-sticky-top, 0px)')
    expect(revealRule).toContain('grid-template-rows: 0fr')
    expect(innerRule).toContain('overflow: clip')
    expect(settingsRule).toContain('overflow: clip')
  })

  it('keeps the closed reveal free of intrinsic box-model height', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/assets/main.css'), 'utf8')
    const revealRule = css.match(/\.collapse-reveal \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const innerRule = css.match(/\.collapse-inner \{([\s\S]*?)\n\}/)?.[1] ?? ''

    // The 0fr row can only finish at zero height when the reveal adds no
    // padding/block border/minimum of its own and the grid item may shrink
    // below its content. `overflow: clip` keeps the clipped rows out of the
    // scrollport without turning the inner div into a scroll container.
    expect(revealRule).not.toMatch(/\b(?:height|min-height|padding)\s*:/)
    expect(revealRule).not.toMatch(
      /\bborder(?:-(?:top|bottom|block|block-start|block-end))?(?:-width)?\s*:/
    )
    expect(innerRule).toContain('min-height: 0')
    expect(innerRule).toContain('overflow: clip')
    expect(innerRule).not.toMatch(/\bpadding\s*:/)
    expect(innerRule).not.toMatch(
      /\bborder(?:-(?:top|bottom|block|block-start|block-end))?(?:-width)?\s*:/
    )
  })
})
