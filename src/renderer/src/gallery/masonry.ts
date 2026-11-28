export const TILE_GAP = 12
const MIN_COLUMN = 220
const FALLBACK_ASPECT = 16 / 9

export interface TileBox {
  x: number
  y: number
  w: number
  h: number
}

export function masonryLayout(width: number, aspects: number[]) {
  const count = Math.max(1, Math.floor((width + TILE_GAP) / (MIN_COLUMN + TILE_GAP)))
  const colWidth = width > 0 ? (width - (count - 1) * TILE_GAP) / count : MIN_COLUMN
  const columns = Array.from({ length: count }, () => ({ indices: [] as number[], height: 0 }))
  const boxes = aspects.map((aspect, index): TileBox => {
    let column = 0
    for (let i = 1; i < count; i++) {
      if (columns[i].height < columns[column].height) column = i
    }
    const target = columns[column]
    const height = colWidth / Math.max(0.15, Math.min(8, aspect || FALLBACK_ASPECT))
    const box = { x: column * (colWidth + TILE_GAP), y: target.height, w: colWidth, h: height }
    target.indices.push(index)
    target.height += height + TILE_GAP
    return box
  })
  const height = Math.max(0, ...columns.map((column) => column.height - TILE_GAP))
  return { boxes, columns, height }
}

export function visibleTiles(layout: ReturnType<typeof masonryLayout>, top: number, bottom: number): number[] {
  const { boxes, columns } = layout
  const visible: number[] = []
  for (const { indices } of columns) {
    let left = 0
    let right = indices.length
    while (left < right) {
      const middle = Math.floor((left + right) / 2)
      const box = boxes[indices[middle]]
      if (box.y + box.h < top) left = middle + 1
      else right = middle
    }
    for (let i = left; i < indices.length && boxes[indices[i]].y <= bottom; i++) {
      visible.push(indices[i])
    }
  }
  return visible.sort((a, b) => a - b)
}
