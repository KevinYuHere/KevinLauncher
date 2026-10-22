/**
 * 霆骇列律 page-switch text effect.
 *
 * Every line of text on the new page gets a translucent white rectangle that
 * grows from the start of that text line to its end at a fixed speed, then
 * fades. `Range.getClientRects()` gives the actual line boxes, so the sweep
 * stops at the end of the text rather than at the layout container.
 */
/**
 * True when the line box is inside every scroll/clip container above it. The
 * collapsed sections in the linked-launch and module pages keep layout rects for
 * their hidden children; without this they paint sweeps over empty space.
 */
function visibleInAncestors(el: HTMLElement, rect: DOMRect): boolean {
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  let node: HTMLElement | null = el
  while (node) {
    const style = getComputedStyle(node)
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      const box = node.getBoundingClientRect()
      if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) return false
    }
    node = node.parentElement
  }
  return true
}

export function sweepPageText(): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  document.querySelectorAll('.theme-text-sweep').forEach((el) => el.remove())
  const root = document.querySelector('.stage')
  if (!root) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  let lineIndex = 0
  let created = 0
  while (node && created < 24) {
    const raw = node.textContent ?? ''
    const first = raw.search(/\S/)
    const end = raw.replace(/\s+$/, '').length
    const parent = node.parentElement
    const visible =
      parent &&
      (typeof parent.checkVisibility === 'function'
        ? parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        : true)
    const secondary =
      parent?.closest(
        '.settings-desc, .hint, .page-subtitle, .about-disclaimer, .update-notes, .empty'
      ) != null
    if (
      first >= 0 &&
      end > first &&
      parent &&
      visible &&
      !secondary &&
      !parent.closest('[aria-hidden="true"], script, style, option, textarea, input')
    ) {
      const range = document.createRange()
      // Trim leading/trailing whitespace from the range: otherwise indentation
      // inside JSX widens the rect and the sweep appears over empty space.
      range.setStart(node, first)
      range.setEnd(node, end)
      const rects = [...range.getClientRects()].filter(
        (rect) =>
          rect.width > 5 &&
          rect.height > 5 &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight
      )
      for (const rect of rects) {
        if (created >= 24) break
        if (!visibleInAncestors(parent, rect)) continue
        // Also verify the rendered point belongs to this text line; this catches
        // text covered by another surface even when its layout rect exists.
        const hit = document.elementFromPoint(
          Math.min(window.innerWidth - 1, rect.left + Math.min(rect.width / 2, 6)),
          Math.min(window.innerHeight - 1, rect.top + rect.height / 2)
        )
        if (!hit || !(hit === parent || parent.contains(hit))) continue
        created += 1
        const fill = document.createElement('span')
        fill.className = 'theme-text-sweep'
        fill.style.left = `${rect.left}px`
        fill.style.top = `${rect.top}px`
        fill.style.width = `${rect.width}px`
        fill.style.height = `${rect.height}px`
        fill.dataset.sweepText = raw.slice(first, end).trim().slice(0, 60)
        // Start collapsed; without this the browser paints one full-width frame
        // before the WAAPI animation starts (the "max rectangle" flash).
        fill.style.transform = 'scaleX(0)'
        const line = document.createElement('span')
        line.className = 'theme-text-sweep-line'
        fill.appendChild(line)
        document.body.appendChild(fill)
        const duration = Math.min(1000, Math.max(220, rect.width / 1.05))
        const delay = Math.min(260, lineIndex * 26)
        lineIndex += 1
        const anim = fill.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
          duration,
          delay,
          easing: 'linear',
          fill: 'forwards'
        })
        anim.finished
          .then(() => {
            fill.animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: 170,
              easing: 'ease-out',
              fill: 'forwards'
            })
            window.setTimeout(() => fill.remove(), 190)
          })
          .catch(() => fill.remove())
      }
    }
    node = walker.nextNode()
  }
}
