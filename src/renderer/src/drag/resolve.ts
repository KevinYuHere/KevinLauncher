/** Reusable placement strategies for dragging (1D reorder / 2D push-out). */

export interface Rect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface Size {
  w: number
  h: number
}

const overlap = (a: Rect, b: Rect, gap: number): boolean =>
  a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y

/**
 * 2D push-out: keep the (immovable) target where it is and shove every other
 * module out of the way along its minimum-overlap axis; overlap between the other
 * modules is resolved too, and everything is clamped to bounds. Deterministic and
 * bounded. Returns the moved positions and whether the result is conflict-free.
 */
export function pushOut2D(
  others: Rect[],
  target: Rect,
  gap: number,
  bounds: Size
): { moves: Map<string, { x: number; y: number }>; resolved: boolean } {
  const items = others.map((o) => ({ ...o }))
  const all: Rect[] = [{ ...target, id: '__target__' }, ...items]
  const inBounds = (it: Rect, x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x + it.w <= bounds.w && y + it.h <= bounds.h
  /** How many of the placed rects a candidate position would still collide with. */
  const conflicts = (it: Rect, x: number, y: number): number => {
    const cand: Rect = { id: it.id, x, y, w: it.w, h: it.h }
    let n = 0
    for (const other of all) {
      if (other === it) continue
      if (overlap(cand, other, gap)) n++
    }
    return n
  }
  let guard = 0
  let movedAny = true
  while (movedAny && guard++ < 500) {
    movedAny = false
    for (const it of items) {
      for (const other of all) {
        if (other === it || !overlap(it, other, gap)) continue
        const ox = Math.min(it.x + it.w, other.x + other.w) - Math.max(it.x, other.x)
        const oy = Math.min(it.y + it.h, other.y + other.h) - Math.max(it.y, other.y)
        if (ox <= 0 || oy <= 0) continue
        const dirX = it.x + it.w / 2 >= other.x + other.w / 2 ? 1 : -1
        const dirY = it.y + it.h / 2 >= other.y + other.h / 2 ? 1 : -1
        // One candidate per axis, each just clearing this overlap (+ gap). Score
        // them by how many *other* rects they would then hit and keep one that
        // leads out of the cluster — this is what stops the old up/down boun-
        // cing between two neighbours (which reported "no space" spuriously).
        const cands = [
          { x: it.x + dirX * (ox + gap), y: it.y },
          { x: it.x, y: it.y + dirY * (oy + gap) }
        ]
        const usable = cands
          .map((c) => ({ ...c, fits: inBounds(it, c.x, c.y), n: conflicts(it, c.x, c.y) }))
          .filter((c) => c.fits)
        let pick: { x: number; y: number }
        if (usable.length > 0) {
          usable.sort((a, b) => a.n - b.n)
          pick = usable[0]
        } else {
          // Both leave the bounds: fall back to the minimum-overlap axis.
          pick = ox < oy ? cands[0] : cands[1]
        }
        const nx = Math.max(0, Math.min(bounds.w - it.w, pick.x))
        const ny = Math.max(0, Math.min(bounds.h - it.h, pick.y))
        if (nx !== it.x || ny !== it.y) movedAny = true
        it.x = nx
        it.y = ny
      }
    }
  }
  const moves = new Map<string, { x: number; y: number }>()
  for (const it of items) moves.set(it.id, { x: it.x, y: it.y })
  // Only the target must end up clear of the others — pre-existing spacing
  // between the stationary modules must not count as "no space". Tolerate a
  // couple of px so a merely *near* (not overlapping) drop isn't rejected.
  const t = all[0]
  const resolved = !items.some((it) => overlap(it, t, -3))
  return { moves, resolved }
}
