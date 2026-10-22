import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  KevinApi,
  NewAppEntry,
  AppEntry,
  GlassPatch,
  HomeModuleId,
  HomeModuleState,
  LaunchEffect,
  LaunchMethod,
  LinkedLaunch,
  WallpaperSettings,
  CloseAction,
  AfterLaunchAction,
  AutoStartMode
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
  setIcon: (appId: string, sourcePath: string | null) =>
    ipcRenderer.invoke('apps:setIcon', appId, sourcePath),
  setIconData: (appId: string, dataUrl: string | null) =>
    ipcRenderer.invoke('apps:setIconData', appId, dataUrl),
  resetIcon: (appId: string) => ipcRenderer.invoke('apps:resetIcon', appId),
  setAutoTheme: (appId: string, on: boolean) => ipcRenderer.invoke('apps:setAutoTheme', appId, on),
  pickIconSource: () => ipcRenderer.invoke('dialog:pickIconSource'),
  iconFromPath: (path: string) => ipcRenderer.invoke('image:iconFromPath', path),
  readImage: (path: string) => ipcRenderer.invoke('image:read', path),
  listFonts: () => ipcRenderer.invoke('fonts:list'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  desktopWallpaper: () => ipcRenderer.invoke('wallpaper:desktop'),
  getLauncherSettings: () => ipcRenderer.invoke('launcher:getSettings'),
  setLauncherIcon: (dataUrl: string | null) => ipcRenderer.invoke('launcher:setIcon', dataUrl),
  setLauncherFont: (family: string | null) => ipcRenderer.invoke('launcher:setFont', family),
  setLauncherBehavior: (patch: {
    closeAction?: CloseAction
    afterLaunch?: AfterLaunchAction
    autoStart?: AutoStartMode
    sidebarMaterial?: boolean
    themeAreas?: Partial<Record<string, string>>
  }) => ipcRenderer.invoke('launcher:setBehavior', patch),
  hideToTray: () => ipcRenderer.invoke('window:hideToTray'),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),
  setThemeColor: (appId: string, color: string | null) =>
    ipcRenderer.invoke('apps:setThemeColor', appId, color),
  setGlass: (appId: string, patch: GlassPatch) => ipcRenderer.invoke('apps:setGlass', appId, patch),
  setGachaShowSecond: (appId: string, value: boolean) =>
    ipcRenderer.invoke('apps:setGachaShowSecond', appId, value),
  setBgTuning: (appId: string, tuning: { blur: number; dim: number }) =>
    ipcRenderer.invoke('apps:setBgTuning', appId, tuning),
  setHomeModule: (appId: string, moduleId: HomeModuleId, patch: Partial<HomeModuleState>) =>
    ipcRenderer.invoke('apps:setHomeModule', appId, moduleId, patch),
  setLaunchEffect: (appId: string, effect: LaunchEffect) =>
    ipcRenderer.invoke('apps:setLaunchEffect', appId, effect),
  setModuleLabel: (appId: string, label: string | null) =>
    ipcRenderer.invoke('apps:setModuleLabel', appId, label),
  exportLogs: () => ipcRenderer.invoke('logs:export'),
  extractThemeColor: (appId: string) => ipcRenderer.invoke('apps:extractThemeColor', appId),

  setLaunchMethods: (appId: string, methods: LaunchMethod[], defaultId: string) =>
    ipcRenderer.invoke('apps:setLaunchMethods', appId, methods, defaultId),

  pickWallpapers: () => ipcRenderer.invoke('wallpaper:pick'),
  wallpaperAdd: (appId: string, sourcePath: string) =>
    ipcRenderer.invoke('wallpaper:add', appId, sourcePath),
  wallpaperRemove: (appId: string, wallpaperId: string) =>
    ipcRenderer.invoke('wallpaper:remove', appId, wallpaperId),
  wallpaperReorder: (appId: string, ids: string[]) =>
    ipcRenderer.invoke('wallpaper:reorder', appId, ids),
  wallpaperSettings: (appId: string, patch: Partial<WallpaperSettings>) =>
    ipcRenderer.invoke('wallpaper:settings', appId, patch),
  wallpaperStep: (appId: string, delta: number) =>
    ipcRenderer.invoke('wallpaper:step', appId, delta),
  wallpaperAdvance: (appId: string) => ipcRenderer.invoke('wallpaper:advance', appId),
  wallpaperReset: (appId: string) => ipcRenderer.invoke('wallpaper:reset', appId),
  wallpaperSelect: (appId: string, index: number) =>
    ipcRenderer.invoke('wallpaper:select', appId, index),
  wallpaperOpenViewer: (appId: string, index: number) =>
    ipcRenderer.invoke('wallpaper:viewer', appId, index),

  listLinkedLaunches: () => ipcRenderer.invoke('linked:list'),
  addLinkedLaunch: (input: Omit<LinkedLaunch, 'id' | 'showInGamesRow'> & { showInGamesRow?: boolean }) =>
    ipcRenderer.invoke('linked:add', input),
  updateLinkedLaunch: (entry: LinkedLaunch) => ipcRenderer.invoke('linked:update', entry),
  removeLinkedLaunch: (id: string) => ipcRenderer.invoke('linked:remove', id),
  reorderLinkedLaunches: (ids: string[]) => ipcRenderer.invoke('linked:reorder', ids),
  setAppLinkedLaunches: (appId: string, ids: string[], defaultId: string | null) =>
    ipcRenderer.invoke('linked:setApp', appId, ids, defaultId),
  launchLinkedLaunch: (id: string) => ipcRenderer.invoke('linked:launch', id),

  launchApp: (id: string, methodId?: string) => ipcRenderer.invoke('apps:launch', id, methodId),
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
  galleryOpenViewer: (paths: string[], index: number) =>
    ipcRenderer.invoke('gallery:openViewer', paths, index),
  galleryViewerNav: (delta: number) => ipcRenderer.invoke('gallery:viewerNav', delta),
  galleryContextMenu: (path: string) => ipcRenderer.invoke('gallery:contextMenu', path),

  pickExecutable: () => ipcRenderer.invoke('dialog:pickExecutable'),
  pickBackground: () => ipcRenderer.invoke('dialog:pickBackground'),
  pickImage: () => ipcRenderer.invoke('dialog:pickImage'),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  appUpdateStatus: () => ipcRenderer.invoke('appUpdate:status'),
  appUpdateCheck: () => ipcRenderer.invoke('appUpdate:check'),
  appUpdateState: () => ipcRenderer.invoke('appUpdate:state'),
  appUpdateStart: () => ipcRenderer.invoke('appUpdate:start'),
  appUpdateToggle: () => ipcRenderer.invoke('appUpdate:toggle'),

  installerInfo: () => ipcRenderer.invoke('installer:info'),
  installerNormalize: (dir: string) => ipcRenderer.invoke('installer:normalize', dir),
  installerRunning: () => ipcRenderer.invoke('installer:running'),
  installerInspect: (dir: string) => ipcRenderer.invoke('installer:inspect', dir),
  installerFreeSpace: (dir: string) => ipcRenderer.invoke('installer:freeSpace', dir),
  installerPickDirectory: (current: string) => ipcRenderer.invoke('installer:pickDirectory', current),
  installerRun: (dir: string, dataDir?: string) =>
    ipcRenderer.invoke('installer:run', dir, dataDir),
  installerLaunch: (dir: string) => ipcRenderer.invoke('installer:launch', dir),

  uninstallerInfo: () => ipcRenderer.invoke('uninstaller:info'),
  uninstallerRun: (keepUserData: boolean) => ipcRenderer.invoke('uninstaller:run', keepUserData),

  dataDirGet: () => ipcRenderer.invoke('dataDir:get'),
  dataDirPick: (current: string) => ipcRenderer.invoke('dataDir:pick', current),
  dataDirSet: (dir: string) => ipcRenderer.invoke('dataDir:set', dir),

  housekeepingUsage: () => ipcRenderer.invoke('housekeeping:usage'),
  housekeepingClean: (kinds: ('staging' | 'thumbs' | 'logs')[]) =>
    ipcRenderer.invoke('housekeeping:clean', kinds),

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
  onWindowShown: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('window:shown', listener)
    return () => ipcRenderer.removeListener('window:shown', listener)
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
  onAppUpdateState: (callback: (state: import('@shared/types').AppUpdateState) => void) => {
    const listener = (_e: unknown, state: import('@shared/types').AppUpdateState): void =>
      callback(state)
    ipcRenderer.on('app-update:state', listener)
    return () => ipcRenderer.removeListener('app-update:state', listener)
  },
  onInstallerProgress: (
    callback: (progress: import('@shared/types').InstallerProgress) => void
  ) => {
    const listener = (
      _e: unknown,
      progress: import('@shared/types').InstallerProgress
    ): void => callback(progress)
    ipcRenderer.on('installer:progress', listener)
    return () => ipcRenderer.removeListener('installer:progress', listener)
  },
  onUninstallerProgress: (callback: (progress: { step: string }) => void) => {
    const listener = (_e: unknown, progress: { step: string }): void => callback(progress)
    ipcRenderer.on('uninstaller:progress', listener)
    return () => ipcRenderer.removeListener('uninstaller:progress', listener)
  },
  onDataDirProgress: (callback: (progress: { step: string }) => void) => {
    const listener = (_e: unknown, progress: { step: string }): void => callback(progress)
    ipcRenderer.on('dataDir:progress', listener)
    return () => ipcRenderer.removeListener('dataDir:progress', listener)
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
