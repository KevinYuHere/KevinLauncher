import { AppStore } from '../services/appStore'
import { discoverGames } from '../services/gameDiscovery'
import { log } from '../services/logger'
import { handleIpc } from './access'

/**
 * On-demand, read-only discovery. This handler never imports a game and never
 * writes config; the renderer must show the verified candidates and call the
 * existing `apps:add` command only after the user's confirmation.
 */
export function registerGameDiscoveryIpc(): void {
  handleIpc('gameDiscovery:scan', async () => {
    const apps = (await AppStore.load()).apps
    const result = await discoverGames({ existingApps: apps })
    log(`gameDiscovery: ${result.candidates.length} verified candidate(s)`)
    return result
  })
}
