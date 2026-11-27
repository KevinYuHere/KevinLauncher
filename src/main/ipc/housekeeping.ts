import { handleIpc } from './access'
import { clean, usage } from '../services/housekeeping'
import type { DiskCacheKind } from '@shared/types'

/** Disk housekeeping (settings → 清理与占用). */
export function registerHousekeepingIpc(): void {
  handleIpc('housekeeping:usage', () => usage())
  handleIpc('housekeeping:clean', (_e, kinds: DiskCacheKind[]) => {
    if (!Array.isArray(kinds) || kinds.some((kind) => !['staging', 'thumbs', 'logs'].includes(kind))) {
      throw new Error('无法识别要清理的内容，请刷新后重试')
    }
    return clean(kinds)
  })
}
