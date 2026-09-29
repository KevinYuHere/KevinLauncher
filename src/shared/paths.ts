/**
 * Path helpers shared by the main and renderer processes.
 */

/** Normalises a directory for comparison (separators + trailing slash + case). */
function normalize(dir: string): string {
  return dir.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/**
 * True when two directories are equal or one contains the other. Used to keep
 * the user data directory and the program directory strictly apart — having one
 * inside the other would make upgrades/uninstalls destroy the user's data.
 */
export function directoriesOverlap(a: string, b: string): boolean {
  const left = normalize(a)
  const right = normalize(b)
  if (!left || !right) return false
  if (left === right) return true
  return left.startsWith(`${right}\\`) || right.startsWith(`${left}\\`)
}
