import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'

const electron = vi.hoisted(() => ({ data: '' }))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => electron.data,
    getAppPath: () => process.cwd()
  }
}))

import {
  isAllowedMediaRead,
  isGalleryMediaFile,
  isTrustedDirectory,
  rememberGalleryDirectory,
  rememberGalleryListing,
  rememberSelectedDirectory,
  rememberSelectedFile,
  resetMediaAccessForTests,
  resolveScreenshotDirectory,
  resolveScreenshotDirectoryChange,
  resolveShellOpenTarget
} from '../src/main/services/mediaAccess'
import { copyMedia } from '../src/main/services/mediaFiles'
import { serveMediaFile } from '../src/main/services/mediaProtocol'

let root = ''

beforeEach(async () => {
  resetMediaAccessForTests()
  root = await fs.mkdtemp(join(tmpdir(), 'kl-media-boundary-'))
  electron.data = join(root, 'data')
  await fs.mkdir(join(electron.data, 'bg'), { recursive: true })
})

afterEach(async () => {
  resetMediaAccessForTests()
  await fs.rm(root, { recursive: true, force: true })
})

describe('renderer media boundary', () => {
  it('allows managed assets and picker selections but rejects arbitrary files', async () => {
    const managed = join(electron.data, 'bg', 'asset.png')
    const picked = join(root, 'picked.png')
    const secret = join(root, 'secret.png')
    const notes = join(root, 'notes.txt')
    await fs.writeFile(managed, 'managed')
    await fs.writeFile(picked, 'picked')
    await fs.writeFile(secret, 'secret')
    await fs.writeFile(notes, 'notes')

    const roots = [join(electron.data, 'bg')]
    expect(isAllowedMediaRead(managed, roots)).toBe(true)
    expect(isAllowedMediaRead(secret, roots)).toBe(false)
    expect(isAllowedMediaRead(notes, roots)).toBe(false)
    expect(isAllowedMediaRead('relative.png', roots)).toBe(false)

    rememberSelectedFile(picked)
    expect(isAllowedMediaRead(picked, roots)).toBe(true)
    expect(isAllowedMediaRead(secret, roots)).toBe(false)
  })

  it('replaces one gallery listing without leaving stale files readable', async () => {
    const dir = join(root, 'shots')
    const first = join(dir, 'first.png')
    const second = join(dir, 'second.png')
    await fs.mkdir(dir)
    await fs.writeFile(first, '1')
    await fs.writeFile(second, '2')

    rememberGalleryDirectory('app', dir)
    rememberGalleryListing('app', [first, second])
    expect(isGalleryMediaFile(first)).toBe(true)
    expect(isGalleryMediaFile(second)).toBe(true)
    expect(isTrustedDirectory(dir)).toBe(true)

    rememberGalleryListing('app', [second])
    expect(isGalleryMediaFile(first)).toBe(false)
    expect(isGalleryMediaFile(second)).toBe(true)
  })

  it('only lets stored, picked or already verified directories back a gallery', async () => {
    const shots = join(root, 'shots')
    const picked = join(root, 'picked shots')
    const legacy = join(root, 'legacy shots')
    const stranger = join(root, 'stranger')
    const file = join(root, 'not-a-directory.png')
    await Promise.all([shots, picked, legacy, stranger].map((dir) => fs.mkdir(dir)))
    await fs.writeFile(file, 'x')

    await expect(resolveScreenshotDirectoryChange(null, null)).resolves.toBeNull()
    await expect(resolveScreenshotDirectoryChange(shots, '')).resolves.toBeNull()

    // A renderer cannot introduce an arbitrary local directory, even when it exists.
    await expect(resolveScreenshotDirectoryChange(null, stranger)).rejects.toThrow('未授权')
    await expect(resolveScreenshotDirectoryChange(null, shots)).rejects.toThrow('未授权')

    // The saved value may be retained without a new picker round-trip.
    await expect(resolveScreenshotDirectoryChange(shots, shots)).resolves.toBe(shots)

    rememberSelectedDirectory(picked)
    await expect(resolveScreenshotDirectoryChange(null, picked)).resolves.toBe(picked)

    // A gallery verified by an earlier main-process listing remains usable.
    rememberGalleryDirectory('existing', legacy)
    await expect(resolveScreenshotDirectoryChange(null, legacy)).resolves.toBe(legacy)

    // Directory identity and shape are checked before a picker path is stored.
    rememberSelectedDirectory(file)
    await expect(resolveScreenshotDirectoryChange(null, file)).rejects.toThrow('截图目录无效')
    rememberSelectedDirectory(parse(root).root)
    await expect(resolveScreenshotDirectoryChange(null, parse(root).root)).rejects.toThrow('截图目录无效')
    await expect(resolveScreenshotDirectoryChange(null, join(root, 'missing'))).rejects.toThrow('未授权')
    rememberSelectedDirectory(join(root, 'missing'))
    await expect(resolveScreenshotDirectoryChange(null, join(root, 'missing'))).rejects.toThrow('不存在')
    await expect(resolveScreenshotDirectory(file)).rejects.toThrow('截图目录无效')
    await expect(resolveScreenshotDirectory(join(root, 'missing'))).rejects.toThrow('不存在')
  })

  it('opens only real trusted directories and selected safe media', async () => {
    const selectedDir = join(root, 'shots')
    const strangerDir = join(root, 'stranger')
    const media = join(root, 'picked.png')
    const executable = join(root, 'setup.exe')
    await fs.mkdir(selectedDir)
    await fs.mkdir(strangerDir)
    await fs.writeFile(media, 'media')
    await fs.writeFile(executable, 'exe')
    rememberSelectedDirectory(selectedDir)
    rememberSelectedFile(media)
    rememberSelectedFile(executable)

    await expect(resolveShellOpenTarget(selectedDir)).resolves.toMatchObject({ kind: 'directory' })
    await expect(resolveShellOpenTarget(strangerDir)).rejects.toThrow('未授权')
    await expect(resolveShellOpenTarget(media)).resolves.toMatchObject({ kind: 'media' })
    await expect(resolveShellOpenTarget(executable)).rejects.toThrow('未授权')
    await expect(resolveShellOpenTarget(join(root, 'missing.png'))).rejects.toThrow('位置已失效')
  })

  it('serves authorized files with ranges and refuses unregistered ones', async () => {
    const file = join(root, 'secret.png')
    await fs.writeFile(file, 'secret')
    const request = (range?: string): Request =>
      new Request('http://localhost/media', range ? { headers: { range } } : undefined)

    expect((await serveMediaFile(file, request())).status).toBe(403)
    rememberSelectedFile(file)
    const response = await serveMediaFile(file, request())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('secret')

    const partial = await serveMediaFile(file, request('bytes=0-2'))
    expect(partial.status).toBe(206)
    expect(partial.headers.get('Content-Range')).toBe('bytes 0-2/6')
    expect(await partial.text()).toBe('sec')
  })

  it('imports only picker-selected media into a managed directory', async () => {
    const source = join(root, 'source.png')
    const destination = join(electron.data, 'bg')
    await fs.writeFile(source, 'source')
    await expect(copyMedia(destination, 'new.png', source)).rejects.toThrow('媒体来源未授权')
    rememberSelectedFile(source)
    await expect(copyMedia(destination, 'new.png', source)).resolves.toBe('new.png')
    await expect(fs.readFile(join(destination, 'new.png'), 'utf8')).resolves.toBe('source')
  })
})
