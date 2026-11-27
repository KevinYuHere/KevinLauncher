import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { copyMedia, saveMedia } from './mediaFiles'

/** Stores per-application custom icon files under `%userData%/icons`. */
export class IconStore {
  static dir(): string {
    return join(app.getPath('userData'), 'icons')
  }

  /** Import an image file chosen by the user (png/jpg/webp/ico/...). */
  static async import(sourcePath: string): Promise<string> {
    const ext = (sourcePath.match(/\.[^.\\/]+$/)?.[0] ?? '.png').toLowerCase()
    return copyMedia(this.dir(), `${randomUUID()}${ext}`, sourcePath)
  }

  /** Save a png buffer (e.g. an icon extracted from an executable). */
  static async savePng(buffer: Buffer): Promise<string> {
    return saveMedia(this.dir(), `${randomUUID()}.png`, buffer)
  }
}
