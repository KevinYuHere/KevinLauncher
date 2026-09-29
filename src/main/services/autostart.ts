import { app } from 'electron'
import type { AutoStartMode } from '@shared/types'
import { log } from './logger'

/** Argument added to the Run entry so the window stays hidden (tray mode). */
export const TRAY_START_ARG = '--tray'

/**
 * Registers / removes the launcher in the current user's "run at logon" entry
 * (HKCU\...\Run). NOTE: the packaged app requires administrator rights, so
 * Windows will still show a UAC prompt at logon.
 */
export function applyAutoStart(mode: AutoStartMode): void {
  if (!app.isPackaged) {
    log(`autoStart: dev build, not writing the Run entry (${mode})`)
    return
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: mode !== 'off',
      path: process.execPath,
      args: mode === 'tray' ? [TRAY_START_ARG] : []
    })
    log(`autoStart: ${mode}`)
  } catch (error) {
    log(`autoStart: failed: ${(error as Error).message}`)
  }
}

/** True when this process was started by the Run entry in silent mode. */
export function startedHidden(): boolean {
  return process.argv.includes(TRAY_START_ARG)
}
