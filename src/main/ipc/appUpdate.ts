import { handleIpc } from './access'
import { appUpdate, broadcast } from './context'

/** Launcher self-update (GitHub Releases): status + download/install control. */
export function registerAppUpdateIpc(): void {
  appUpdate.onUpdate((info) => broadcast('app-update:available', info))
  appUpdate.onState((state) => broadcast('app-update:state', state))

  handleIpc('appUpdate:status', () => appUpdate.status())
  handleIpc('appUpdate:check', () => appUpdate.check('manual'))
  handleIpc('appUpdate:state', () => appUpdate.stateSnapshot())
  handleIpc('appUpdate:start', () => appUpdate.begin())
  handleIpc('appUpdate:toggle', () => appUpdate.toggle())
}
