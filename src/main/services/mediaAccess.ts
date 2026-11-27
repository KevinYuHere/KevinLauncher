import { promises as fs } from 'fs'
import { basename, extname, isAbsolute, relative, resolve } from 'path'
import { isMediaFilename } from '@shared/mediaReferences'
import { isFileSystemRoot } from './directoryPath'

/**
 * Renderer-facing media is limited to files the main process already owns or
 * the user explicitly picked. Registrations are kept in memory only: loading
 * them from disk would turn the protocol into a filesystem scanner, and a
 * restart should require a fresh gallery/business read or picker selection.
 */
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.jpe', '.jfif', '.webp', '.gif', '.bmp', '.avif', '.ico'
])
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi'
])
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS])

const MAX_SELECTED_FILES = 8192
const MAX_SELECTED_DIRECTORIES = 1024
const MAX_GALLERY_FILES = 5000

const selectedFiles = new Set<string>()
const selectedFileOrder: string[] = []
const selectedDirectories = new Set<string>()
const selectedDirectoryOrder: string[] = []
const galleryFiles = new Map<string, Set<string>>()
const galleryDirectories = new Map<string, string>()

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32768 &&
    !value.includes('\0') && isAbsolute(value)
}

function pathKey(value: string): string {
  const resolved = resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function hasMediaName(value: string): boolean {
  const name = basename(value)
  return name.length > 0 && isMediaFilename(name)
}

export function isSafeMediaPath(value: unknown): value is string {
  return isAbsolutePath(value) && hasMediaName(value) &&
    MEDIA_EXTENSIONS.has(extname(value).toLowerCase())
}

export function isImageMediaPath(value: unknown): value is string {
  return isAbsolutePath(value) && hasMediaName(value) &&
    IMAGE_EXTENSIONS.has(extname(value).toLowerCase())
}

export function isSelectedFile(value: unknown): boolean {
  return isAbsolutePath(value) && selectedFiles.has(pathKey(value))
}

/** A path returned by a trusted file picker. Directories are tracked separately. */
export function rememberSelectedFile(value: unknown): boolean {
  if (!isAbsolutePath(value)) return false
  const key = pathKey(value)
  if (selectedFiles.has(key)) return true
  selectedFiles.add(key)
  selectedFileOrder.push(key)
  while (selectedFileOrder.length > MAX_SELECTED_FILES) {
    const oldest = selectedFileOrder.shift()
    if (oldest) selectedFiles.delete(oldest)
  }
  return true
}

export function rememberSelectedFiles(values: readonly unknown[]): void {
  for (const value of values) rememberSelectedFile(value)
}

export function rememberSelectedDirectory(value: unknown): boolean {
  if (!isAbsolutePath(value)) return false
  const key = pathKey(value)
  if (selectedDirectories.has(key)) return true
  selectedDirectories.add(key)
  selectedDirectoryOrder.push(key)
  while (selectedDirectoryOrder.length > MAX_SELECTED_DIRECTORIES) {
    const oldest = selectedDirectoryOrder.shift()
    if (oldest) selectedDirectories.delete(oldest)
  }
  return true
}

/** The screenshot directory currently backing an app's gallery. */
export function rememberGalleryDirectory(appId: string, value: unknown): boolean {
  if (typeof appId !== 'string' || appId.length === 0) return false
  if (!isAbsolutePath(value)) {
    galleryDirectories.delete(appId)
    return false
  }
  galleryDirectories.set(appId, pathKey(value))
  return true
}

/**
 * Screenshot directories the main process itself has already accepted: a
 * native directory picker result or a gallery directory verified by
 * `gallery:list`. A renderer-supplied path is never trusted merely because it
 * was stored in config.
 */
function isTrustedScreenshotDirectory(value: unknown): boolean {
  if (!isAbsolutePath(value) || isFileSystemRoot(value)) return false
  const key = pathKey(value)
  if (selectedDirectories.has(key)) return true
  for (const directory of galleryDirectories.values()) {
    if (directory === key) return true
  }
  return false
}

/**
 * Verify that a screenshot directory is a real, stable local directory.
 *
 * The path identity check is deliberately stricter than the sparse media-read
 * check: a screenshot directory is a recursive gallery root, so a junction or
 * symlink in the path could redirect a whole listing outside the location the
 * user approved. The returned path is the canonical candidate path on success.
 */
export async function resolveScreenshotDirectory(value: unknown): Promise<string> {
  if (!isAbsolutePath(value) || isFileSystemRoot(value)) throw new Error('截图目录无效')
  let info
  try {
    info = await fs.lstat(value)
  } catch {
    throw new Error('截图目录不存在或无法访问')
  }
  if (!info.isDirectory()) throw new Error('截图目录无效')
  let real: string
  try {
    real = await fs.realpath(value)
  } catch {
    throw new Error('截图目录无法读取')
  }
  if (!isAbsolutePath(real) || isFileSystemRoot(real) || pathKey(real) !== pathKey(value)) {
    throw new Error('截图目录的实际位置与所选路径不一致，请重新选择')
  }
  return resolve(value)
}

/**
 * Authorise a change to an app's screenshot directory.
 *
 * Only clearing it, retaining the saved value, or switching to a directory the
 * main process already accepted (picker or verified gallery) is allowed. The
 * newly selected directory must also pass the real-directory identity check.
 * New game-discovery candidates are ordinary renderer input here and cannot
 * bypass these checks.
 */
export async function resolveScreenshotDirectoryChange(
  current: unknown,
  next: unknown
): Promise<string | null> {
  if (next === null || next === undefined || (typeof next === 'string' && next.trim() === '')) {
    return null
  }
  if (!isAbsolutePath(next) || isFileSystemRoot(next)) throw new Error('截图目录无效')
  if (isAbsolutePath(current) && pathKey(current) === pathKey(next)) return current
  if (!isTrustedScreenshotDirectory(next)) {
    throw new Error('截图目录未授权，请通过“选择目录”设置')
  }
  return resolveScreenshotDirectory(next)
}

/** Replace the trusted files for one gallery listing. */
export function rememberGalleryListing(appId: string, values: readonly unknown[]): void {
  if (typeof appId !== 'string' || appId.length === 0) return
  const files = new Set<string>()
  if (Array.isArray(values)) {
    for (const value of values) {
      if (files.size >= MAX_GALLERY_FILES) break
      if (isImageMediaPath(value)) files.add(pathKey(value))
    }
  }
  if (files.size === 0) galleryFiles.delete(appId)
  else galleryFiles.set(appId, files)
}

function isGalleryPath(value: string): boolean {
  const key = pathKey(value)
  for (const files of galleryFiles.values()) {
    if (files.has(key)) return true
  }
  return false
}

export function isGalleryMediaFile(value: unknown): boolean {
  return isImageMediaPath(value) && isGalleryPath(value)
}

export function isTrustedDirectory(value: unknown): boolean {
  if (!isAbsolutePath(value)) return false
  const key = pathKey(value)
  if (selectedDirectories.has(key)) return true
  for (const directory of galleryDirectories.values()) {
    if (directory === key) return true
  }
  return false
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * A local media path is readable only when it is one of the launcher's own
 * asset files, a file from a current gallery listing, or a picker selection.
 * This is intentionally cheap (no stat/realpath/WMI) because video range
 * requests hit it on every chunk.
 */
export function isAllowedMediaRead(value: unknown, roots: readonly string[]): boolean {
  if (!isSafeMediaPath(value)) return false
  if (isSelectedFile(value) || isGalleryPath(value)) return true
  return roots.some((root) => typeof root === 'string' && root.length > 0 && isWithin(root, value))
}

export interface ShellOpenTarget {
  path: string
  kind: 'directory' | 'media'
}

/**
 * Resolve a shell-open request to a real directory the main process knows
 * about, or a safe media file the user picked earlier. Executables, shortcuts,
 * stale paths and arbitrary folders are rejected before touching the shell.
 */
export async function resolveShellOpenTarget(value: unknown): Promise<ShellOpenTarget> {
  if (!isAbsolutePath(value)) throw new Error('位置无效')
  let real: string
  try {
    real = await fs.realpath(value)
    const info = await fs.stat(real)
    if (info.isDirectory()) {
      if (!isTrustedDirectory(value) && !isTrustedDirectory(real)) {
        throw new Error('未授权的目录')
      }
      return { path: real, kind: 'directory' }
    }
    if (!info.isFile()) throw new Error('位置无效')
  } catch (error) {
    if (error instanceof Error && (error.message === '未授权的目录' || error.message === '位置无效')) {
      throw error
    }
    throw new Error('位置已失效')
  }
  if (!isSafeMediaPath(real) || (!isSelectedFile(value) && !isSelectedFile(real))) {
    throw new Error('未授权的文件')
  }
  return { path: real, kind: 'media' }
}

/** Test-only: clear process-wide trust without touching user files. */
export function resetMediaAccessForTests(): void {
  selectedFiles.clear()
  selectedFileOrder.length = 0
  selectedDirectories.clear()
  selectedDirectoryOrder.length = 0
  galleryFiles.clear()
  galleryDirectories.clear()
}
