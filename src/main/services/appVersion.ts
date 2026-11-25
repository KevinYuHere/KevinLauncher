import { app } from 'electron'
import { readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { SAFE_VERSION } from './appUpdateManifest'

export interface LoadedApplication {
  version: string
  directory: string
  pending: boolean
  recordStartup?: () => void
}

export function loadedApplication(): LoadedApplication | undefined {
  if (!app.isPackaged) return undefined
  const key = Symbol.for('kevin-launcher.loaded-application')
  const identity = Reflect.get(process, key) as LoadedApplication | undefined
  if (identity && SAFE_VERSION.test(identity.version) &&
      identity.directory.toLowerCase() === join(dirname(identity.directory), `app-${identity.version}`).toLowerCase()) {
    return identity
  }
  // Old shells do not expose identity. The current bundle still knows its own
  // directory even when that shell ran it as a fallback for an invalid pointer.
  const directory = resolve(__dirname, '../..')
  const fromDirectory = /[/\\]app-([^/\\]+)$/.exec(directory)?.[1]
  if (fromDirectory && SAFE_VERSION.test(fromDirectory) &&
      dirname(directory).toLowerCase() === process.resourcesPath?.toLowerCase()) {
    return { version: fromDirectory, directory, pending: false }
  }
  return undefined
}

/**
 * The version of the **installed** application.
 *
 * The packaged launcher keeps its code in `resources/app-<version>/` and the
 * current version in `resources/app-version.txt`, so `app.getVersion()` (the
 * shell's package.json) is not authoritative. In development the shell layout
 * does not exist and `app.getVersion()` is used.
 */
export function currentAppVersion(): string {
  if (app.isPackaged) {
    const loaded = loadedApplication()
    if (loaded) return loaded.version
    try {
      const version = readFileSync(join(process.resourcesPath, 'app-version.txt'), 'utf8').trim()
      if (SAFE_VERSION.test(version)) return version
    } catch {
      /* fall back to the packaged metadata */
    }
  }
  return app.getVersion()
}
