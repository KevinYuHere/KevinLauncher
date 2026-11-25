import { app } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'

/** Stores per-application custom icon files under `%userData%/icons`. */
export class IconStore {
  static dir(): string {
    return join(app.getPath('userData'), 'icons')
  }

  static async ensure(): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true })
  }

  /** Import an image file chosen by the user (png/jpg/webp/ico/...). */
  static async import(sourcePath: string): Promise<string> {
    await this.ensure()
    const ext = (sourcePath.match(/\.[^.\\/]+$/)?.[0] ?? '.png').toLowerCase()
    const name = `${randomUUID()}${ext}`
    await fs.copyFile(sourcePath, join(this.dir(), name))
    return name
  }

  /** Save a png buffer (e.g. an icon extracted from an executable). */
  static async savePng(buffer: Buffer): Promise<string> {
    await this.ensure()
    const name = `${randomUUID()}.png`
    await fs.writeFile(join(this.dir(), name), buffer)
    return name
  }

  static async remove(file: string): Promise<void> {
    try {
      await fs.unlink(join(this.dir(), file))
    } catch {
      /* ignore missing file */
    }
  }
}
