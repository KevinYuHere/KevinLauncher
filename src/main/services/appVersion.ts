import { app } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The version of the **installed** application.
 *
 * The packaged launcher keeps its code in `resources/app-<version>/` and the
 * current version in `resources/app-version.txt` (see docs/INSTALLER.md), so
 * `app.getVersion()` (the shell's package.json) is not authoritative. In
 * development the shell layout does not exist and `app.getVersion()` is used.
 */
export function currentAppVersion(): string {
  if (app.isPackaged) {
    try {
      const version = readFileSync(join(process.resourcesPath, 'app-version.txt'), 'utf8').trim()
      if (version) return version
    } catch {
      /* fall back to the packaged metadata */
    }
  }
  return app.getVersion()
}
