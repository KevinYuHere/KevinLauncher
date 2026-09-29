import { app } from 'electron'
import { execFile } from 'child_process'
import type { AutoStartMode } from '@shared/types'
import { log } from './logger'

/** Argument added when starting hidden (tray mode). */
export const TRAY_START_ARG = '--tray'

/** Name of the Task Scheduler entry used for autostart. */
export const AUTO_START_TASK = 'KevinLauncher'

function runSchtasks(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    execFile('schtasks', args, { windowsHide: true }, (error) => {
      resolve(error ? ((error as { code?: number }).code ?? 1) : 0)
    })
  })
}

/**
 * Applies the launch-at-login preference.
 *
 * A scheduled task with `/RL HIGHEST` is used rather than the Run key because
 * the launcher is manifested `requireAdministrator`: the Run key would show a
 * UAC prompt at every logon, while the task starts it elevated silently.
 * (The task is therefore only writable while the launcher runs elevated.)
 */
export async function applyAutoStart(mode: AutoStartMode): Promise<void> {
  if (!app.isPackaged) {
    log(`autoStart: dev build, nothing applied (${mode})`)
    return
  }
  try {
    if (mode === 'off') {
      await runSchtasks(['/Delete', '/F', '/TN', AUTO_START_TASK])
      app.setLoginItemSettings({ openAtLogin: false })
      log('autoStart: off')
      return
    }
    // Always recreate: keeps the path correct after an update or a reinstall.
    const command =
      mode === 'tray' ? `"${process.execPath}" ${TRAY_START_ARG}` : `"${process.execPath}"`
    const code = await runSchtasks([
      '/Create',
      '/F',
      '/TN',
      AUTO_START_TASK,
      '/SC',
      'ONLOGON',
      '/RL',
      'HIGHEST',
      '/TR',
      command
    ])
    if (code === 0) {
      // Make sure an older Run-key entry is not left behind.
      app.setLoginItemSettings({ openAtLogin: false })
      log(`autoStart: ${mode} (scheduled task)`)
      return
    }
    // Fallback: the Run key (shows a UAC prompt at logon).
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
      args: mode === 'tray' ? [TRAY_START_ARG] : []
    })
    log(`autoStart: ${mode} (Run key fallback, schtasks exit ${code})`)
  } catch (error) {
    log(`autoStart: failed: ${(error as Error).message}`)
  }
}

/** True when this process was started by the autostart entry in silent mode. */
export function startedHidden(): boolean {
  return process.argv.includes(TRAY_START_ARG)
}

/** Removes both the scheduled task and the Run-key fallback (used by uninstall). */
export async function removeAutoStartTask(): Promise<void> {
  await runSchtasks(['/Delete', '/F', '/TN', AUTO_START_TASK])
  try {
    app.setLoginItemSettings({ openAtLogin: false })
  } catch {
    /* ignore */
  }
  log('autoStart: removed')
}
