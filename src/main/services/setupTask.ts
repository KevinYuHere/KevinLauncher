import { app } from 'electron'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { trialBuild, trialDirectory } from './buildIdentity'
import { log } from './logger'

let active = false

/** The setup UI must have a Chromium profile separate from a running launcher. */
export function isolateSetupSession(): void {
  const root = trialBuild ? trialDirectory('integration') : realpathSync(app.getPath('temp'))
  const session = mkdtempSync(join(root, 'kevin-setup-session-'))
  try {
    app.setPath('sessionData', session)
  } catch (error) {
    rmSync(session, { recursive: true, force: true })
    throw error
  }
  app.once('quit', () => {
    try {
      rmSync(session, { recursive: true, force: true, maxRetries: 3, retryDelay: 80 })
    } catch (error) {
      log(`setup: could not remove the temporary Chromium profile at ${session} (${String(error)})`)
    }
  })
}

export function setupTaskActive(): boolean {
  return active
}

/** Hold the setup window open until its filesystem and system writes settle. */
export async function runSetupTask<T>(task: () => Promise<T>): Promise<T> {
  if (active) throw new Error('安装或卸载操作正在进行')
  active = true
  try {
    return await task()
  } finally {
    active = false
  }
}
