import { ipcMain } from 'electron'
import { clean, usage } from '../services/housekeeping'

/** Disk housekeeping (settings → 清理与占用). */
export function registerHousekeepingIpc(): void {
  ipcMain.handle('housekeeping:usage', () => usage())
  ipcMain.handle('housekeeping:clean', (_e, kinds: ('staging' | 'thumbs' | 'logs')[]) =>
    clean(kinds)
  )
}
