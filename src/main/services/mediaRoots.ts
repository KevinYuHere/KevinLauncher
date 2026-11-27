import { app } from 'electron'
import { join } from 'path'
import { MEDIA_DIRECTORIES } from '@shared/mediaReferences'

/** Directories the launcher itself owns and may serve to its renderers. */
export function managedMediaRoots(): string[] {
  const userData = app.getPath('userData')
  const resources = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), 'resources')
  return [...MEDIA_DIRECTORIES.map((directory) => join(userData, directory)), resources]
}
