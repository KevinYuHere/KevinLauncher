/**
 * The launcher deliberately does not show hover tooltips: only a few controls
 * used native `title` attributes (the rail, game chips, progress rings …), which
 * looked inconsistent with the rest of the UI. Strip every `title` and keep the
 * text as `aria-label` so assistive technology still gets a name.
 *
 * A MutationObserver covers React re-renders and portals that add `[title]`
 * after mount. Default theme and themed builds share this behaviour.
 */
export function installNoNativeTooltips(): () => void {
  const strip = (root: ParentNode): void => {
    const elements =
      root instanceof Element && root.hasAttribute('title')
        ? [root as HTMLElement, ...root.querySelectorAll<HTMLElement>('[title]')]
        : [...root.querySelectorAll<HTMLElement>('[title]')]
    for (const element of elements) {
      const text = element.getAttribute('title')?.trim()
      element.removeAttribute('title')
      if (text && !element.hasAttribute('aria-label')) element.setAttribute('aria-label', text)
    }
  }

  strip(document)
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLElement) {
        strip(record.target)
        continue
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element) strip(node)
      }
    }
  })
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['title']
  })
  return () => observer.disconnect()
}
