import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type PointerEvent as ReactPointerEvent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import SortableGrip from '../src/renderer/src/components/SortableGrip'
import type { SortableHandle } from '../src/renderer/src/components/Sortable'

function grip(handle: SortableHandle, label?: string, size?: number): string {
  return renderToStaticMarkup(createElement(SortableGrip, { handle, label, size }))
}

function handle(dragging = false): SortableHandle {
  return { dragging, onPointerDown: vi.fn() }
}

function component(file: string): string {
  return readFileSync(join(process.cwd(), 'src/renderer/src/components', file), 'utf8')
}

describe('SortableGrip', () => {
  it('renders the shared grip button, copy, icon and dragging state', () => {
    const idle = grip(handle())
    expect(idle).toContain('type="button"')
    expect(idle).toContain('class="ll-grip"')
    expect(idle).toContain('title="拖动排序"')
    expect(idle).toContain('aria-label="拖动排序"')
    expect(idle).toContain('width="16"')
    expect(idle).toContain('height="16"')

    const active = grip(handle(true), '拖动排序；Alt+↑ / ↓ 也可移动', 18)
    expect(active).toContain('class="ll-grip dragging"')
    expect(active).toContain('title="拖动排序；Alt+↑ / ↓ 也可移动"')
    expect(active).toContain('aria-label="拖动排序；Alt+↑ / ↓ 也可移动"')
    expect(active).toContain('width="18"')
    expect(active).toContain('height="18"')
  })

  it('forwards the Sortable pointer handle unchanged', () => {
    const onPointerDown = vi.fn()
    const element = SortableGrip({ handle: { dragging: false, onPointerDown } })
    expect(element.props.onPointerDown).toBe(onPointerDown)

    const event = {} as ReactPointerEvent<HTMLElement>
    element.props.onPointerDown(event)
    expect(onPointerDown).toHaveBeenCalledWith(event)
  })

  it('is the only grip in each migrated list; GamesRow keeps dragging the whole chip', () => {
    const usages: [string, number][] = [
      ['LinkedLaunchView.tsx', 1],
      ['ModuleManagerView.tsx', 2],
      ['LaunchMethodsEditor.tsx', 2],
      ['KevinHudSettings.tsx', 1]
    ]
    for (const [file, count] of usages) {
      const source = component(file)
      expect(source).toContain("from './SortableGrip'")
      expect(source.match(/<SortableGrip\b/g)).toHaveLength(count)
      expect(source).not.toContain('ll-grip')
    }

    const gamesRow = component('GamesRow.tsx')
    expect(gamesRow).toContain('dragWhole')
    expect(gamesRow).not.toContain('SortableGrip')

    // The row's keyboard move still targets the shared grip class.
    expect(component('Sortable.tsx')).toContain("event.target.closest('.ll-grip')")
  })

  it('keeps the one shared .ll-grip size and interaction CSS', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/assets/main.css'), 'utf8')
    const rule = css.match(/\.ll-grip \{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(rule).toContain('width: 30px')
    expect(rule).toContain('height: 30px')
    expect(rule).toContain('cursor: grab')
    expect(rule).toContain('touch-action: none')
    expect(css).toContain('.ll-grip.dragging')
    expect(css).toContain('.ll-grip:active')
    expect(css).toContain('cursor: grabbing')
  })
})
