import { lstatSync, mkdirSync, realpathSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { trialBuild } from '@shared/buildIdentity'
import windowsLayout from '@shared/windowsLayout.json'
export { trialBuild } from '@shared/buildIdentity'
export const launcherProductName = trialBuild ? 'KevinLauncherTrial' : 'KevinLauncher'
export const launcherExecutableName = trialBuild ? `${launcherProductName}.exe` : windowsLayout.entry
export const launcherRuntimeExecutableName = trialBuild ? launcherExecutableName : windowsLayout.runtime
export const launcherProcessNames = new Set([launcherExecutableName, launcherRuntimeExecutableName])
export const launcherAppId = trialBuild ? 'com.kevin.kevinlauncher.trial' : 'com.kevin.kevinlauncher'
export const launcherDisplayName = trialBuild ? 'KevinLauncher 本地试用' : 'KevinLauncher'

/** Resolve the public entry while retaining the dev, trial, and legacy paths. */
export function launcherEntryPath(executable = process.execPath): string {
  return basename(executable).toLowerCase() === launcherRuntimeExecutableName.toLowerCase()
    ? join(dirname(executable), launcherExecutableName)
    : executable
}

/** Fixed, per-user habitat. Reject redirects before touching its children. */
export function trialDirectory(name: 'data' | 'installed' | 'integration'): string {
  const local = process.env.LOCALAPPDATA
  if (!local || !isAbsolute(local)) throw new Error('无法定位本地试用目录')
  const root = join(realpathSync(local), 'KevinLauncherTrial')
  const dir = join(root, name)
  for (const entry of [root, dir]) {
    let stat = lstatSync(entry, { throwIfNoEntry: false })
    if (!stat) {
      try {
        mkdirSync(entry)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      stat = lstatSync(entry)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        realpathSync(entry).toLowerCase() !== resolve(entry).toLowerCase()) {
      throw new Error('本地试用目录必须是未重定向的实体目录')
    }
    if (entry === root && lstatSync(join(root, 'seed-in-progress'), { throwIfNoEntry: false })) {
      throw new Error('正在准备本地试用数据')
    }
  }
  return dir
}

export function assertTrialInstallDirectory(directory: string): void {
  if (!trialBuild) return
  const target = join(trialDirectory('installed'), launcherProductName)
  if (resolve(directory).toLowerCase() !== target.toLowerCase()) {
    throw new Error('本地试用版只能安装到固定的试用目录')
  }
  const stat = lstatSync(target, { throwIfNoEntry: false })
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() ||
      realpathSync(target).toLowerCase() !== target.toLowerCase())) {
    throw new Error('本地试用安装目录必须是未重定向的实体目录')
  }
}

export function trialShortcuts(): { startMenu: string; desktop: string } {
  const base = trialDirectory('integration')
  const paths = {
    startMenu: join(base, 'KevinLauncherTrial-Start.lnk'),
    desktop: join(base, 'KevinLauncherTrial-Desktop.lnk')
  }
  for (const file of Object.values(paths)) {
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) {
      throw new Error('本地试用快捷方式必须是本地独立文件')
    }
  }
  return paths
}
