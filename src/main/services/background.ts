import { app } from 'electron'
import { join, extname } from 'path'
import { randomUUID } from 'crypto'
import { copyMedia } from './mediaFiles'

/**
 * Stores per-application background files under `%userData%/bg`.
 * The renderer loads them through the `kevin-media://bg/<file>` protocol.
 */
export class BgStore {
  static bgDir(): string {
    return join(app.getPath('userData'), 'bg')
  }

  static async import(sourcePath: string): Promise<string> {
    const ext = extname(sourcePath).toLowerCase() || '.bin'
    return copyMedia(this.bgDir(), `${randomUUID()}${ext}`, sourcePath)
  }
}
