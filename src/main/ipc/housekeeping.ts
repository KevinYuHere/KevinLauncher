import { handleIpc } from './access'
import { clean, usage } from '../services/housekeeping'

/** Disk housekeeping (settings → 清理与占用). */
export function registerHousekeepingIpc(): void {
  handleIpc('housekeeping:usage', () => usage())
  handleIpc('housekeeping:clean', (_e, kinds: ('staging' | 'thumbs' | 'logs')[]) =>
    clean(kinds)
  )
}
