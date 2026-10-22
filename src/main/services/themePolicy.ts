import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { ThemePolicy } from '@shared/types'
import {
  applyThemePolicy,
  normalizeThemePolicy,
  policyTargetsVersion
} from '@shared/specialTheme'
import { AppStore } from './appStore'
import { currentAppVersion } from './appVersion'
import { log } from './logger'

/**
 * Release-time theme policy (`theme-policy.json`).
 *
 * The file ships in the version payload (next to the app code) so an in-app
 * update carries it along, or can be dropped into `<userData>` for a local
 * trial. It is applied **once per policy version**: later starts never overwrite
 * the user's own choices again.
 *
 * Policy result: the targeted areas get the theme, and every app gets the
 * policy's glass material and launch effect (when present) on the first run
 * after the release. It does **not** lock anything — the user can change every
 * setting afterwards. The legacy `locked` field is accepted but ignored.
 */

/** Where a policy may live, first match wins. */
function candidates(): string[] {
  const list = [join(app.getPath('userData'), 'theme-policy.json')]
  // The repository keeps the policy for the *next* release at its root, so a
  // development run must not pick it up by accident: only a packaged build
  // reads the copy shipped inside the version directory.
  if (app.isPackaged) {
    list.push(join(process.resourcesPath, `app-${currentAppVersion()}`, 'theme-policy.json'))
  }
  return list
}

/** Read + validate the first readable policy file, or `null` when none exists. */
export async function loadThemePolicy(): Promise<ThemePolicy | null> {
  for (const file of candidates()) {
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf-8')
    } catch {
      continue
    }
    try {
      const policy = normalizeThemePolicy(JSON.parse(raw) as unknown)
      if (policy) {
        log(`themePolicy: using ${file} (v${policy.version}, ${policy.themeId})`)
        return policy
      }
      log(`themePolicy: ignoring invalid policy in ${file}`)
    } catch (error) {
      log(`themePolicy: cannot parse ${file}: ${(error as Error).message}`)
    }
  }
  return null
}

/**
 * Apply the policy when its version has not been applied yet. Returns true when
 * the config changed (the caller may broadcast `launcher:changed`).
 */
export async function applyThemePolicyOnStartup(): Promise<boolean> {
  try {
    const policy = await loadThemePolicy()
    if (!policy) return false
    // Bind the policy to the version it was shipped with: a later release that
    // carries a stale copy (or no file) must never rewrite user data again.
    const version = currentAppVersion()
    if (!policyTargetsVersion(policy, version)) {
      log(`themePolicy: ${policy.version} does not target ${version} - skipped`)
      return false
    }
    const settings = await AppStore.launcherSettings()
    if (settings.themePolicyVersion === policy.version) return false
    const result = applyThemePolicy(settings.themeAreas, settings.themeLocks, policy)
    // Apps first: if that write fails, the policy version stays unset and the
    // whole policy is retried on the next start (re-applying is idempotent).
    const appsChanged = await AppStore.applyReleasePolicyToApps(policy)
    await AppStore.setThemePolicyState({
      themeAreas: result.assignments,
      // A policy applies values once; it never locks the user out.
      themeLocks: {},
      themePolicyVersion: policy.version
    })
    log(
      `themePolicy: applied v${policy.version} → ${policy.themeId}` +
        `${policy.material ? ` · ${policy.material}` : ''}` +
        `${policy.launchEffect ? ` · ${policy.launchEffect}` : ''}` +
        `${appsChanged ? ' (apps updated)' : ''} (user can edit afterwards)`
    )
    return true
  } catch (error) {
    // A broken policy must never prevent the launcher from starting.
    log(`themePolicy: failed to apply: ${(error as Error).message}`)
    return false
  }
}
