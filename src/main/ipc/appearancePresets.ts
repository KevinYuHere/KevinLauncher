import { applyAppearancePreset } from '@shared/appearancePreset'
import { AppStore } from '../services/appStore'
import { appearancePresets } from '../services/appearancePresets'
import { log } from '../services/logger'
import { handleIpc } from './access'
import { broadcast, notifyAppsChanged } from './context'

/**
 * Local appearance presets. Applying runs the config mutation through
 * `AppStore.mutate` so a single atomic config write restores appearance
 * without touching launch methods, app order, wallpapers or other independent
 * data.
 */
export function registerAppearancePresetsIpc(): void {
  handleIpc('appearancePresets:list', () => appearancePresets.list())

  handleIpc('appearancePresets:apply', async (_event, id: string) => {
    if (typeof id !== 'string' || !id) throw new Error('外观预设不存在')
    const preset = await appearancePresets.get(id)
    if (!preset) throw new Error('外观预设不存在')
    let applied = { apps: 0, areas: 0 }
    await AppStore.mutate((config) => {
      applied = applyAppearancePreset(config, preset)
    })
    notifyAppsChanged()
    broadcast('launcher:changed')
    log(`appearancePresets: applied "${preset.name}" (${applied.apps} app(s), ${applied.areas} area(s))`)
    return { presetName: preset.name, ...applied }
  })

  handleIpc('appearancePresets:remove', async (_event, id: string) => {
    if (typeof id !== 'string' || !id) throw new Error('外观预设不存在')
    const remaining = await appearancePresets.remove(id)
    log('appearancePresets: removed one preset')
    return remaining
  })
}
