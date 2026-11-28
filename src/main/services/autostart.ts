import { app } from 'electron'
import { execFile } from 'child_process'
import type { AutoStartMode } from '@shared/types'
import { log } from './logger'
import { launcherEntryPath, trialBuild } from './buildIdentity'
import { psQuote, runPowerShell } from './powershell'

/** Argument added when starting hidden (tray mode). */
export const TRAY_START_ARG = '--tray'

/** Name of the Task Scheduler entry used for autostart. */
export const AUTO_START_TASK = 'KevinLauncher'

function runSchtasks(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    execFile('schtasks', args, { windowsHide: true, timeout: 10000 }, (error) => {
      resolve(error ? ((error as { code?: number }).code ?? 1) : 0)
    })
  })
}

export interface AutoStartResult {
  requested: AutoStartMode
  mechanism: 'scheduled-task' | 'run-key' | 'disabled' | 'isolated'
}

let queue = Promise.resolve()

async function removeScheduledTask(): Promise<void> {
  if (await runSchtasks(['/Delete', '/F', '/TN', AUTO_START_TASK]) === 0) return
  const tasks = await runPowerShell(
    `Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop | Where-Object TaskName -EQ ${psQuote(AUTO_START_TASK)} | Select-Object -ExpandProperty TaskName`,
    { timeout: 10000 }
  )
  if (tasks.trim()) throw new Error('Windows 计划任务无法删除')
}

function updateRunKey(openAtLogin: boolean, path?: string, args?: string[]): void {
  app.setLoginItemSettings({ openAtLogin, path, args })
  if (app.getLoginItemSettings({ path, args }).openAtLogin !== openAtLogin) {
    throw new Error('Windows 启动项状态未生效')
  }
}

/**
 * Applies the launch-at-login preference.
 *
 * A scheduled task with `/RL HIGHEST` is used rather than the Run key because
 * the launcher is manifested `requireAdministrator`: the Run key would show a
 * UAC prompt at every logon, while the task starts it elevated silently.
 * (The task is therefore only writable while the launcher runs elevated.)
 */
export function applyAutoStart(mode: AutoStartMode, executable = launcherEntryPath()): Promise<AutoStartResult> {
  const task = queue.then(async (): Promise<AutoStartResult> => {
    if (trialBuild || !app.isPackaged) return { requested: mode, mechanism: 'isolated' }
    if (mode === 'off') {
      await removeScheduledTask()
      updateRunKey(false)
      return { requested: mode, mechanism: 'disabled' }
    }
    // Always recreate: keeps the path correct after an update or a reinstall.
    const command =
      mode === 'tray' ? `"${executable}" ${TRAY_START_ARG}` : `"${executable}"`
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
      updateRunKey(false)
      return { requested: mode, mechanism: 'scheduled-task' }
    }
    // Fallback: the Run key (shows a UAC prompt at logon).
    await removeScheduledTask()
    updateRunKey(true, executable, mode === 'tray' ? [TRAY_START_ARG] : [])
    return { requested: mode, mechanism: 'run-key' }
  })
  queue = task.then(({ requested, mechanism }) => {
    log(`autoStart: ${requested} (${mechanism})`)
  }, (error) => log(`autoStart: failed: ${String(error)}`))
  return task
}

/** True when this process was started by the autostart entry in silent mode. */
export function startedHidden(): boolean {
  return process.argv.includes(TRAY_START_ARG)
}
