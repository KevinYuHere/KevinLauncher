import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { ReleaseUpgradePolicy } from '@shared/specialTheme'
import { normalizeReleaseUpgradePolicy } from '@shared/specialTheme'
import { AppStore, type ReleaseUpgradeResult } from './appStore'
import { currentAppVersion } from './appVersion'
import { clearUpgradeSource, readUpgradeSource } from './appActivation'
import { log } from './logger'

/**
 * Release payload actions (`theme-policy.json`) for the **exact** installed
 * version:
 *
 * - `intro`: one-time "what's new" dialog (independent opt-in);
 * - optional flat theme/material/launch-effect fields: one-time setting patch.
 *
 * The file ships inside `app-<version>/` so an in-app update carries it. A copy
 * in `<userData>` is kept as the local/trial override, but a stale copy is
 * skipped and never blocks the bundled file for the running version.
 *
 * Nothing is applied at process startup: both actions wait until the real main
 * window is healthy and visible, and then only when a proof says a real older
 * version was replaced.
 */

export type ReleasePolicyLoad =
  | { status: 'ok'; policy: ReleaseUpgradePolicy }
  | { status: 'none' }
  | { status: 'unreadable' }

function candidates(version: string): string[] {
  const list: string[] = []
  if (app.isPackaged) {
    // The payload copy is authoritative. The development tree intentionally
    // does not read the repository's next-release policy by accident.
    list.push(join(process.resourcesPath, `app-${version}`, 'theme-policy.json'))
  }
  list.push(join(app.getPath('userData'), 'theme-policy.json'))
  return list
}

/** Read the first usable policy whose version exactly matches the caller. */
export async function loadReleaseUpgradePolicy(
  version = currentAppVersion()
): Promise<ReleasePolicyLoad> {
  let unreadable = false
  for (const file of candidates(version)) {
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        unreadable = true
        log(`themePolicy: cannot read ${file}: ${(error as Error).message}`)
      }
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      unreadable = true
      log(`themePolicy: cannot parse ${file}: ${(error as Error).message}`)
      continue
    }

    const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
    const declared = typeof record?.version === 'string' ? record.version.trim() : ''
    if (declared && declared !== version) {
      // Keep the old file untouched and continue to the bundle for this version.
      log(`themePolicy: ${file} targets ${declared}; running ${version}`)
      continue
    }

    const policy = normalizeReleaseUpgradePolicy(parsed)
    if (policy) {
      log(`themePolicy: using ${file} (v${policy.version})`)
      return { status: 'ok', policy }
    }

    if (record?.critical === true) {
      log(`themePolicy: ${file} is a critical-only marker (no client action)`)
      continue
    }

    if (declared === version) {
      unreadable = true
      log(`themePolicy: ignoring invalid policy in ${file}`)
      continue
    }

    // A malformed file without a usable version cannot be confirmed.
    unreadable = true
    log(`themePolicy: ignoring invalid policy in ${file}`)
  }
  return { status: unreadable ? 'unreadable' : 'none' }
}

/**
 * Apply the running version's payload actions after the main window is healthy
 * and visible. Quietly returns no action for missing/rolled-back/unknown data.
 */
export async function applyUpgradeFeaturesOnReady(): Promise<ReleaseUpgradeResult> {
  const nothing: ReleaseUpgradeResult = { changed: false, intro: null }
  if (!app.isPackaged) return nothing

  try {
    const dataDir = app.getPath('userData')
    const version = currentAppVersion()
    const source = await readUpgradeSource(dataDir)
    // A rollback leaves a proof for the failed target; it must not run here.
    if (!source || source.to !== version) return nothing

    const loaded = await loadReleaseUpgradePolicy(version)
    if (loaded.status === 'unreadable') return nothing
    if (loaded.status === 'none') {
      // There is no payload action for this target: consume the proof.
      await clearUpgradeSource(dataDir)
      return nothing
    }

    const result = await AppStore.applyReleaseUpgrade(loaded.policy)
    // Keep the proof while an introduction is waiting to be displayed: a
    // restart before the renderer confirms it must be able to offer it again.
    if (!result.intro) await clearUpgradeSource(dataDir)
    if (result.changed) {
      log(
        `themePolicy: v${loaded.policy.version} from ${source.from} ` +
          `(theme=${loaded.policy.theme ? 'on' : 'off'}, ` +
          `intro=${!loaded.policy.intro ? 'off' : result.intro ? 'pending' : 'already applied'})`
      )
    }
    return result
  } catch (error) {
    // A broken policy/record must never prevent the launcher from starting.
    log(`themePolicy: failed to apply upgrade features: ${(error as Error).message}`)
    return nothing
  }
}

/**
 * Mark an introduction as delivered only after the main renderer has actually
 * displayed it. The upgrade proof is consumed at the same point.
 */
export async function completeUpgradeIntro(): Promise<boolean> {
  if (!app.isPackaged) return false
  try {
    const dataDir = app.getPath('userData')
    const version = currentAppVersion()
    const source = await readUpgradeSource(dataDir)
    if (!source || source.to !== version) return false
    const loaded = await loadReleaseUpgradePolicy(version)
    if (loaded.status !== 'ok' || !loaded.policy.intro) return false
    const marked = await AppStore.markFeatureIntroApplied(version)
    // Already-marked is also a completed state: consume a stale proof.
    await clearUpgradeSource(dataDir)
    if (marked) log(`themePolicy: recorded introduction v${version} after display`)
    return marked
  } catch (error) {
    log(`themePolicy: failed to record the introduction (${(error as Error).message})`)
    return false
  }
}
