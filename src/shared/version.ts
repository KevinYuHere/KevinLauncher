/**
 * Version helpers used by the GitHub release check.
 *
 * Pre-release suffixes are handled like SemVer: `1.2.5-beta.1 < 1.2.5`.
 */

function splitVersion(version: string): { core: number[]; pre: string | null } {
  // Ignore a leading `v`, build metadata, and split off the pre-release part.
  const cleaned = version.trim().replace(/^v/i, '').split('+')[0]
  const dash = cleaned.indexOf('-')
  const core = dash >= 0 ? cleaned.slice(0, dash) : cleaned
  const pre = dash >= 0 ? cleaned.slice(dash + 1) : null
  const numbers = core.split('.').map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) ? value : 0
  })
  return { core: numbers, pre: pre || null }
}

function comparePre(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  const length = Math.max(pa.length, pb.length)
  for (let i = 0; i < length; i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d < 0 ? -1 : 1
    } else if (nx) {
      return -1
    } else if (ny) {
      return 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/**
 * Compares two versions (`1.2.3`, optional leading `v`, optional `-pre`).
 * Returns a negative number when `a < b`, `0` when they are equal and a
 * positive number when `a > b`.
 */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a)
  const right = splitVersion(b)
  const length = Math.max(left.core.length, right.core.length)
  for (let i = 0; i < length; i++) {
    const x = left.core[i] ?? 0
    const y = right.core[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  // Same core: a release outranks its pre-releases.
  if (left.pre === null && right.pre === null) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  return comparePre(left.pre, right.pre)
}

/** True when `candidate` is a strictly newer version than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}
