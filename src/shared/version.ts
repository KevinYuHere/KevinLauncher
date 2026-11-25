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

/**
 * Whether a staged update folder (`update-staging/<version>`) must be kept.
 *
 * The running version is kept for reference; a **newer** one is an update that
 * was not finished yet and must resume from its `.part` files on the next
 * launch. Everything older is stale.
 */
export function keepStagedVersion(name: string, current: string): boolean {
  return name === current || isNewerVersion(name, current)
}

/** A release as seen by the update channel selection. */
export interface ReleaseCandidate {
  version: string
  /** GitHub drafts are never offered. */
  draft?: boolean
  /** Pre-release: hidden from the stable channel. */
  prerelease?: boolean
}

/**
 * Newest release by **version** (GitHub lists by publication date).
 *
 * - `stableOnly: true` → pre-releases are skipped, so the stable channel only
 *   ever sees a real release;
 * - `stableOnly: false` → every release competes; a stable version outranks its
 *   own pre-releases, so the beta channel takes whatever is actually newest.
 */
export function pickNewestVersion<T extends ReleaseCandidate>(
  releases: T[],
  stableOnly: boolean
): T | null {
  let best: T | null = null
  for (const release of releases) {
    if (release.draft) continue
    if (stableOnly && release.prerelease) continue
    if (!best || compareVersions(release.version, best.version) > 0) best = release
  }
  return best
}
