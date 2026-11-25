import { powerMonitor, type BrowserWindow } from 'electron'

let locked = false
let suspended = false
const drawable = new WeakMap<BrowserWindow, boolean>()

export function windowVisualActivity(window: BrowserWindow | null): boolean {
  return !locked && !suspended && (window ? drawable.get(window) !== false : false)
}

export function observeWindowActivity(window: BrowserWindow, startsHidden = false): void {
  drawable.set(window, !startsHidden)
  locked = powerMonitor.getSystemIdleState(1) === 'locked'
  const send = (): void => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('window:activity', windowVisualActivity(window))
    }
  }
  const show = (): void => { drawable.set(window, true); send() }
  const hide = (): void => { drawable.set(window, false); send() }
  window.on('show', show)
  window.on('restore', show)
  window.on('hide', hide)
  window.on('minimize', hide)
  const lock = (): void => { locked = true; send() }
  const unlock = (): void => { locked = false; send() }
  const suspend = (): void => { suspended = true; send() }
  const resume = (): void => {
    suspended = false
    locked = powerMonitor.getSystemIdleState(1) === 'locked'
    send()
  }
  powerMonitor.on('lock-screen', lock)
  powerMonitor.on('unlock-screen', unlock)
  powerMonitor.on('suspend', suspend)
  powerMonitor.on('resume', resume)
  window.once('closed', () => {
    powerMonitor.off('lock-screen', lock)
    powerMonitor.off('unlock-screen', unlock)
    powerMonitor.off('suspend', suspend)
    powerMonitor.off('resume', resume)
  })
}
