import { app } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'

/** Wrap a PNG buffer as a single-image 256×256 ICO (for shortcuts). */
function pngToIco(png: Buffer): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry.writeUInt8(0, 0) // width 256
  entry.writeUInt8(0, 1) // height 256
  entry.writeUInt8(0, 2)
  entry.writeUInt8(0, 3)
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12)
  return Buffer.concat([header, entry, png])
}

/** Stores the launcher's own (global) icon under `%userData%/brand`. */
export class BrandStore {
  static dir(): string {
    return join(app.getPath('userData'), 'brand')
  }

  static async ensure(): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true })
  }

  static async savePng(buffer: Buffer): Promise<string> {
    await this.ensure()
    const name = `${randomUUID()}.png`
    await fs.writeFile(join(this.dir(), name), buffer)
    return name
  }

  /** Save an .ico (derived from the same PNG) next to `pngFile`. */
  static async saveIcoFor(pngFile: string, png: Buffer): Promise<string> {
    await this.ensure()
    const name = `${pngFile.replace(/\.png$/i, '')}.ico`
    await fs.writeFile(join(this.dir(), name), pngToIco(png))
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
