import type { AddonDescriptor } from '@shared/types'

/**
 * Game add-on catalog. This only describes *what a game can do*.
 * It never contains executable names or install paths: an add-on is bound to
 * an application entry explicitly by the user, so launching through another
 * launcher or a `.bat` script keeps working.
 */
export const ADDONS: AddonDescriptor[] = [
  {
    id: 'genshin',
    name: '原神',
    capabilities: { gacha: true, update: true, gallery: true },
    defaultMonitorProcessNames: ['YuanShen.exe']
  },
  {
    id: 'starrail',
    name: '崩坏：星穹铁道',
    capabilities: { gacha: true, update: true, gallery: true },
    defaultMonitorProcessNames: ['StarRail.exe']
  },
  {
    id: 'zzz',
    name: '绝区零',
    capabilities: { gacha: true, update: true, gallery: true },
    defaultMonitorProcessNames: ['ZenlessZoneZero.exe']
  },
  {
    id: 'arknights',
    name: '明日方舟',
    capabilities: { gacha: true, update: true, gallery: true },
    defaultMonitorProcessNames: ['Arknights.exe']
  }
]
