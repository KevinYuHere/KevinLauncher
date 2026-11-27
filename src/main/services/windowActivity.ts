import { powerMonitor, type BrowserWindow } from 'electron'

let locked = false
let suspended = false
const drawable = new WeakMap<BrowserWindow, boolean>()

export function windowVisualActivity(window: BrowserWindow | null): boolean {
  return !locked && !suspended && (window ? drawable.get(window) !== false : false)
}

/**
 * Track window visibility/focus and system lock/sleep. `onForegroundChange`
 * reports the launcher polling foreground (visible, focused, unlocked, awake).
 */
export function observeWindowActivity(
  window: BrowserWindow,
  startsHidden = false,
  onForegroundChange?: (foreground: boolean) => void
): void {
  drawable.set(window, !startsHidden)
  locked = powerMonitor.getSystemIdleState(1) === 'locked'
  suspended = false
  let visible = false
  let minimized = false
  let focused = false
  let reported: boolean | undefined
  const report = (): void => {
    const foreground = !locked && !suspended && visible && !minimized && focused
    if (foreground === reported) return
    reported = foreground
    onForegroundChange?.(foreground)
  }
  const send = (): void => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('window:activity', windowVisualActivity(window))
    }
  }
  const show = (): void => {
    drawable.set(window, true)
    visible = true
    minimized = false
    send()
    report()
  }
  const hide = (): void => {
    drawable.set(window, false)
    visible = false
    focused = false
    send()
    report()
  }
  const minimize = (): void => {
    drawable.set(window, false)
    visible = false
    minimized = true
    focused = false
    send()
    report()
  }
  const restore = (): void => {
    drawable.set(window, true)
    visible = true
    minimized = false
    send()
    report()
  }
  const focus = (): void => {
    focused = true
    report()
  }
  const blur = (): void => {
    focused = false
    report()
  }
  window.on('show', show)
  window.on('restore', restore)
  window.on('hide', hide)
  window.on('minimize', minimize)
  window.on('focus', focus)
  window.on('blur', blur)
  const lock = (): void => { locked = true; send(); report() }
  const unlock = (): void => { locked = false; send(); report() }
  const suspend = (): void => { suspended = true; send(); report() }
  const resume = (): void => {
    suspended = false
    locked = powerMonitor.getSystemIdleState(1) === 'locked'
    send()
    report()
  }
  powerMonitor.on('lock-screen', lock)
  powerMonitor.on('unlock-screen', unlock)
  powerMonitor.on('suspend', suspend)
  powerMonitor.on('resume', resume)
  report()
  window.once('closed', () => {
    powerMonitor.off('lock-screen', lock)
    powerMonitor.off('unlock-screen', unlock)
    powerMonitor.off('suspend', suspend)
    powerMonitor.off('resume', resume)
  })
}
