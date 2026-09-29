/**
 * Version helpers used by the GitHub release check.
 */

function parse(version: string): number[] {
  // Ignore a leading `v`, quoted suffixes, and any pre-release / build parts.
  const core = version
    .trim()
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
  return core.split('.').map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) ? value : 0
  })
}

/**
 * Compares two dotted versions (`1.2.3`, with an optional leading `v`).
 * Returns a negative number when `a < b`, `0` when they are equal and a
 * positive number when `a > b`.
 */
export function compareVersions(a: string, b: string): number {
  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const x = left[i] ?? 0
    const y = right[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** True when `candidate` is a strictly newer version than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}
