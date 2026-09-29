// Ambient declarations for the context bridge: `window.api` (our KevinApi) and
// the toolkit's `window.electron`. Shared by the renderer's type checking.
import type { ElectronAPI } from '@electron-toolkit/preload'
import type { KevinApi } from '@shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: KevinApi
  }
}

export {}
