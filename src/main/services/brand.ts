import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { brandIcoName, saveMedia } from './mediaFiles'

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

  static async savePng(buffer: Buffer): Promise<string> {
    return saveMedia(this.dir(), `${randomUUID()}.png`, buffer)
  }

  /** Save an .ico (derived from the same PNG) next to `pngFile`. */
  static async saveIcoFor(pngFile: string, png: Buffer): Promise<string> {
    return saveMedia(this.dir(), brandIcoName(pngFile), pngToIco(png))
  }
}
