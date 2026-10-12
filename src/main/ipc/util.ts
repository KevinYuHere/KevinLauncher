import { app } from 'electron'
import { promises as fs } from 'fs'
import { extname, join } from 'path'
import { isTransientEntry } from '../services/dataDir'
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

/** Recursively copies `from` into `to` (best effort; a missing source throws). */
export async function copyDir(from: string, to: string): Promise<void> {
  const entries = await fs.readdir(from, { withFileTypes: true })
  await fs.mkdir(to, { recursive: true })
  for (const entry of entries) {
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) await copyDir(src, dst)
    else await fs.copyFile(src, dst)
  }
}

/** Stages the data directory for a backup, skipping transient entries. */
export async function stageBackup(userData: string, stage: string): Promise<void> {
  const entries = await fs.readdir(userData, { withFileTypes: true })
  for (const entry of entries) {
    if (isTransientEntry(entry.name)) continue
    const source = join(userData, entry.name)
    const target = join(stage, entry.name)
    if (entry.isDirectory()) await copyDir(source, target)
    else if (entry.isFile()) await fs.copyFile(source, target)
  }
}

/** Restores a staged backup over the data directory (transient entries skipped). */
export async function restoreBackup(stage: string, userData: string): Promise<string[]> {
  const restored: string[] = []
  const entries = await fs.readdir(stage, { withFileTypes: true })
  for (const entry of entries) {
    if (isTransientEntry(entry.name)) continue
    const source = join(stage, entry.name)
    const target = join(userData, entry.name)
    if (entry.isDirectory()) await copyDir(source, target)
    else if (entry.isFile()) await fs.copyFile(source, target)
    restored.push(entry.name)
  }
  return restored
}
