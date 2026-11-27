import { dirname, isAbsolute } from 'node:path'
import { defaultLaunchMethod } from '@shared/appEntry'
import type { AppEntry } from '@shared/types'

export function gameInstallDirectory(entry: AppEntry): string {
  const explicit = entry.gameDirectory?.trim()
  if (explicit) return isAbsolute(explicit) ? explicit : ''
  const target = defaultLaunchMethod(entry)?.targetPath.trim()
  return target && isAbsolute(target) ? dirname(target) : ''
}
