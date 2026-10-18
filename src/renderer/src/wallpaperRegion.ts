/**
 * Plan-A popup background: each `.wallpaper-region` element shows the part of the
 * current wallpaper that sits under it (the image is fixed at the viewport with a
 * 64px bleed, so the offset is shifted accordingly), then the material tint /
 * texture is composited on top — without sampling the live page (so text behind
 * the popup never bleeds through).
 *
 * This keeps every element's `--wp-x` / `--wp-y` in sync with its on-screen
 * position.
 */
/** Viewport position from the layout box (ignores the open/close scale animation). */
function layoutPosition(el: HTMLElement): { x: number; y: number } {
  let x = 0
  let y = 0
  let node: HTMLElement | null = el
  while (node) {
    x += node.offsetLeft
    y += node.offsetTop
    node = node.offsetParent as HTMLElement | null
  }
  return { x, y }
}

export function updateWallpaperRegions(): void {
  for (const el of document.querySelectorAll<HTMLElement>('.wallpaper-region')) {
    const { x, y } = layoutPosition(el)
    // The wallpaper layer starts 64px outside the viewport (and is centre-cropped
    // by `--wallpaper-cx/cy`), so the offset subtracts both.
    el.style.setProperty('--wp-x', `calc(var(--wallpaper-cx, 0px) - ${x + 64}px)`)
    el.style.setProperty('--wp-y', `calc(var(--wallpaper-cy, 0px) - ${y + 64}px)`)
  }
}

/** Installs the updater; returns a disposer. Call once from the app root. */
export function installWallpaperRegionUpdater(): () => void {
  let raf = 0
  const run = (): void => {
    raf = 0
    updateWallpaperRegions()
  }
  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(run)
  }
  // When a popup is added/removed, set its offset synchronously (the observer
  // microtask runs before paint) so its background never jumps on first paint.
  const observer = new MutationObserver(() => updateWallpaperRegions())
  observer.observe(document.body, { childList: true, subtree: true })
  window.addEventListener('resize', schedule)
  window.addEventListener('scroll', schedule, true)
  updateWallpaperRegions()
  return () => {
    observer.disconnect()
    window.removeEventListener('resize', schedule)
    window.removeEventListener('scroll', schedule, true)
    if (raf) cancelAnimationFrame(raf)
  }
}
