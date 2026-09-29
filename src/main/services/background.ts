import { app } from 'electron'
import { join, extname } from 'path'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'

/**
 * Stores per-application background files under `%userData%/bg`.
 * The renderer loads them through the `kevin-media://bg/<file>` protocol.
 */
export class BgStore {
  static bgDir(): string {
    return join(app.getPath('userData'), 'bg')
  }

  static async ensure(): Promise<void> {
    await fs.mkdir(this.bgDir(), { recursive: true })
  }

  static async import(sourcePath: string): Promise<string> {
    await this.ensure()
    const ext = extname(sourcePath).toLowerCase() || '.bin'
    const name = `${randomUUID()}${ext}`
    await fs.copyFile(sourcePath, join(this.bgDir(), name))
    return name
  }

  static async remove(file: string): Promise<void> {
    try {
      await fs.unlink(join(this.bgDir(), file))
    } catch {
      /* ignore missing file */
    }
  }
}
