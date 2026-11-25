import { app } from 'electron'
import { promises as fs } from 'fs'
import { extname } from 'path'
import { runPowerShell } from '../services/powershell'

/** Decode a `data:<mime>;base64,...` URL into a buffer. */
export function decodeDataUrl(dataUrl: string): Buffer {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl)
  if (!match) throw new Error('无效的图片数据')
  return match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]), 'utf8')
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif'
}

/** Formats an image buffer as a data URL, guessing the MIME type by extension. */
export function imageDataUrl(buffer: Buffer, ext: string): string {
  return `data:${IMAGE_MIME[ext.toLowerCase()] ?? 'image/png'};base64,${buffer.toString('base64')}`
}

const ICON_IMAGE_EXTS = new Set(Object.keys(IMAGE_MIME))

/** Read an image, or extract an executable/shortcut's icon, as a data URL. */
export async function iconDataFromPath(path: string): Promise<string | null> {
  const ext = extname(path).toLowerCase()
  if (ICON_IMAGE_EXTS.has(ext)) {
    try {
      return imageDataUrl(await fs.readFile(path), ext)
    } catch {
      return null
    }
  }
  try {
    const image = await app.getFileIcon(path, { size: 'large' })
    if (!image.isEmpty()) return `data:image/png;base64,${image.toPNG().toString('base64')}`
  } catch {
    /* ignore */
  }
  return null
}

/** Path to the current desktop wallpaper, if it exists. */
export async function getDesktopWallpaper(): Promise<string | null> {
  try {
    const path = (await runPowerShell("(Get-ItemProperty 'HKCU:\\Control Panel\\Desktop').WallPaper")).trim()
    if (!path) return null
    await fs.access(path)
    return path
  } catch {
    return null
  }
}
