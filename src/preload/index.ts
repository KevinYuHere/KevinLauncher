import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  KevinApi,
  NewAppEntry,
  AppEntry,
  GlassStyle,
  CloseAction,
  AfterLaunchAction
} from '@shared/types'

const api: KevinApi = {
  listAddons: () => ipcRenderer.invoke('addons:list'),

  listApps: () => ipcRenderer.invoke('apps:list'),
  addApp: (input: NewAppEntry) => ipcRenderer.invoke('apps:add', input),
  updateApp: (app: AppEntry) => ipcRenderer.invoke('apps:update', app),
  removeApp: (id: string) => ipcRenderer.invoke('apps:remove', id),
  reorderApps: (ids: string[]) => ipcRenderer.invoke('apps:reorder', ids),
  getUiPrefs: () => ipcRenderer.invoke('ui:getPrefs'),
  setGamesRowHidden: (hidden: boolean) => ipcRenderer.invoke('ui:setGamesRowHidden', hidden),
  setBackground: (appId: string, sourcePath: string | null) =>
    ipcRenderer.invoke('apps:setBackground', appId, sourcePath),
  setIcon: (appId: string, sourcePath: string | null) =>
    ipcRenderer.invoke('apps:setIcon', appId, sourcePath),
  setIconData: (appId: string, dataUrl: string | null) =>
    ipcRenderer.invoke('apps:setIconData', appId, dataUrl),
  resetIcon: (appId: string) => ipcRenderer.invoke('apps:resetIcon', appId),
  resetBackground: (appId: string) => ipcRenderer.invoke('apps:resetBackground', appId),
  setAutoTheme: (appId: string, on: boolean) => ipcRenderer.invoke('apps:setAutoTheme', appId, on),
  pickIconSource: () => ipcRenderer.invoke('dialog:pickIconSource'),
  iconFromPath: (path: string) => ipcRenderer.invoke('image:iconFromPath', path),
  readImage: (path: string) => ipcRenderer.invoke('image:read', path),
  listFonts: () => ipcRenderer.invoke('fonts:list'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  getLauncherSettings: () => ipcRenderer.invoke('launcher:getSettings'),
  setLauncherIcon: (dataUrl: string | null) => ipcRenderer.invoke('launcher:setIcon', dataUrl),
  setLauncherFont: (family: string | null) => ipcRenderer.invoke('launcher:setFont', family),
  setLauncherBehavior: (patch: { closeAction?: CloseAction; afterLaunch?: AfterLaunchAction }) =>
    ipcRenderer.invoke('launcher:setBehavior', patch),
  hideToTray: () => ipcRenderer.invoke('window:hideToTray'),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),
  setThemeColor: (appId: string, color: string | null) =>
    ipcRenderer.invoke('apps:setThemeColor', appId, color),
  setGlassStyle: (appId: string, style: GlassStyle) =>
    ipcRenderer.invoke('apps:setGlassStyle', appId, style),
  setBgTuning: (appId: string, tuning: { blur: number; dim: number }) =>
    ipcRenderer.invoke('apps:setBgTuning', appId, tuning),
  extractThemeColor: (appId: string) => ipcRenderer.invoke('apps:extractThemeColor', appId),

  launchApp: (id: string) => ipcRenderer.invoke('apps:launch', id),
  listRunning: () => ipcRenderer.invoke('runtime:list'),
  stopApp: (appId: string) => ipcRenderer.invoke('runtime:stop', appId),

  playTimeTotals: () => ipcRenderer.invoke('playtime:totals'),
  playTimeSummary: (appId: string, days?: number) => ipcRenderer.invoke('playtime:summary', appId, days),

  gachaList: (appId: string) => ipcRenderer.invoke('gacha:list', appId),
  gachaStats: (appId: string) => ipcRenderer.invoke('gacha:stats', appId),
  gachaClear: (appId: string) => ipcRenderer.invoke('gacha:clear', appId),
  gachaUpdateMiHoYo: (appId: string, url: string) =>
    ipcRenderer.invoke('gacha:updateMiHoYo', appId, url),
  gachaLoginArknights: (appId: string) => ipcRenderer.invoke('gacha:loginArknights', appId),
  gachaScanUrl: (appId: string) => ipcRenderer.invoke('gacha:scanUrl', appId),
  gachaExport: (appId: string) => ipcRenderer.invoke('gacha:export', appId),
  gachaImport: (appId: string) => ipcRenderer.invoke('gacha:import', appId),
  updateInfo: (appId: string) => ipcRenderer.invoke('update:info', appId),
  updateStart: (appId: string, mode: 'update' | 'preDownload') =>
    ipcRenderer.invoke('update:start', appId, mode),
  updateCancel: (appId: string) => ipcRenderer.invoke('update:cancel', appId),
  updateStatus: (appId: string) => ipcRenderer.invoke('update:status', appId),
  updateSimulate: (appId: string, mode: 'update' | 'preDownload') =>
    ipcRenderer.invoke('update:simulate', appId, mode),

  galleryList: (appId: string) => ipcRenderer.invoke('gallery:list', appId),
  galleryOpenViewer: (path: string) => ipcRenderer.invoke('gallery:openViewer', path),
  galleryContextMenu: (path: string) => ipcRenderer.invoke('gallery:contextMenu', path),

  pickExecutable: () => ipcRenderer.invoke('dialog:pickExecutable'),
  pickBackground: () => ipcRenderer.invoke('dialog:pickBackground'),
  pickImage: () => ipcRenderer.invoke('dialog:pickImage'),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  appUpdateStatus: () => ipcRenderer.invoke('appUpdate:status'),
  appUpdateCheck: () => ipcRenderer.invoke('appUpdate:check'),
  appUpdateRun: () => ipcRenderer.invoke('appUpdate:run'),

  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  onAppsChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('apps:changed', listener)
    return () => ipcRenderer.removeListener('apps:changed', listener)
  },
  onRunningChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('runtime:changed', listener)
    return () => ipcRenderer.removeListener('runtime:changed', listener)
  },
  onPlayTimeChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('playtime:changed', listener)
    return () => ipcRenderer.removeListener('playtime:changed', listener)
  },
  onGachaProgress: (callback: (progress: import('@shared/types').GachaProgress) => void) => {
    const listener = (_e: unknown, progress: import('@shared/types').GachaProgress): void =>
      callback(progress)
    ipcRenderer.on('gacha:progress', listener)
    return () => ipcRenderer.removeListener('gacha:progress', listener)
  },
  onWindowMaximized: (callback: (maximized: boolean) => void) => {
    const listener = (_e: unknown, maximized: boolean): void => callback(maximized)
    ipcRenderer.on('window:maximized', listener)
    return () => ipcRenderer.removeListener('window:maximized', listener)
  },
  onLauncherChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('launcher:changed', listener)
    return () => ipcRenderer.removeListener('launcher:changed', listener)
  },
  onUpdateProgress: (callback: (status: import('@shared/types').UpdateStatus) => void) => {
    const listener = (_e: unknown, status: import('@shared/types').UpdateStatus): void =>
      callback(status)
    ipcRenderer.on('update:progress', listener)
    return () => ipcRenderer.removeListener('update:progress', listener)
  },
  onAppUpdateAvailable: (callback: (info: import('@shared/types').AppUpdateInfo) => void) => {
    const listener = (_e: unknown, info: import('@shared/types').AppUpdateInfo): void =>
      callback(info)
    ipcRenderer.on('app-update:available', listener)
    return () => ipcRenderer.removeListener('app-update:available', listener)
  },
  onAppUpdateProgress: (
    callback: (progress: import('@shared/types').AppUpdateProgress) => void
  ) => {
    const listener = (
      _e: unknown,
      progress: import('@shared/types').AppUpdateProgress
    ): void => callback(progress)
    ipcRenderer.on('app-update:progress', listener)
    return () => ipcRenderer.removeListener('app-update:progress', listener)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-ignore fallback when context isolation is disabled
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
