import { promises as fs, type BigIntStats } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import { GameFileCatalog, type IndexedGameFile } from './gameFileCatalog'
import { md5File } from './hash'
import { WindowsFileIdentity, type FileIdentity, type HardLinkPlatform } from './windowsFileIdentity'

const MIN_LINK_SIZE = 1024n
const NO_IDENTITY: FileIdentity = { volumeId: 0n, lowId: 0n, highId: 0n }

function hasSupportedFormat(format: string): boolean {
  return format === 'NTFS' || format === 'ReFS'
}

async function fileInfo(path: string): Promise<BigIntStats | null> {
  try {
    const info = await fs.stat(path, { bigint: true })
    return info.isFile() ? info : null
  } catch {
    return null
  }
}

async function link(source: string, target: string): Promise<boolean> {
  const parent = dirname(target)
  await fs.mkdir(parent, { recursive: true })
  const work = await fs.mkdtemp(join(parent, '.kevin-link-'))
  const temporary = join(work, 'new-link')
  let created = false
  try {
    try {
      await fs.link(source, temporary)
      created = true
    } catch {
      return false
    }
    await fs.rename(temporary, target)
    return true
  } finally {
    if (created) await fs.unlink(temporary).catch(() => undefined)
    await fs.rmdir(work).catch(() => undefined)
  }
}

/** Reuse verified file contents across local game installations. */
export class HardLinkService {
  private readonly index: GameFileCatalog
  private readonly active = new Set<Promise<unknown>>()
  private closing = false
  private finalizer: Promise<void> | undefined

  constructor(
    userDataDirectory: string,
    private readonly gameId: string,
    private readonly platform: HardLinkPlatform = new WindowsFileIdentity()
  ) {
    this.index = new GameFileCatalog(userDataDirectory)
  }

  tryLink(path: string, size: number, md5: string, signal?: AbortSignal): Promise<boolean> {
    return this.closing
      ? Promise.resolve(false)
      : this.track(this.findAndLink(resolve(path), size, md5, signal))
  }

  private async findAndLink(
    target: string, expectedSize: number, md5: string, signal?: AbortSignal
  ): Promise<boolean> {
    try {
      const size = BigInt(expectedSize)
      if (size < MIN_LINK_SIZE) return false
      if (!hasSupportedFormat(await this.platform.driveFormat(target))) return false
      const root = parse(target).root
      for (const item of this.index.candidates(target, size, md5)) {
        if (!(await fileInfo(item.path))) {
          this.deleteFile(item.path)
          continue
        }
        if (root !== parse(item.path).root) continue

        const refreshed = await this.refresh(item, signal)
        if (refreshed.length === size && refreshed.digest.toLowerCase() === md5.toLowerCase()) {
          if (await link(refreshed.path, target)) {
            try { this.index.touch(refreshed.path) } catch { /* Index maintenance is best effort. */ }
            void this.track(this.insertVerified(target, expectedSize, md5))
            return true
          }
        }
      }
    } catch {
      // Starward falls through to ordinary update/download if indexing or
      // reuse throws, including cancellation inside the candidate hash.
    }
    return false
  }

  private async refresh(item: IndexedGameFile, signal?: AbortSignal): Promise<IndexedGameFile> {
    const info = await fs.stat(item.path, { bigint: true })
    const digest = await md5File(item.path, signal)
    const identity = await this.platform.fileIdentity(item.path, false)
    const refreshed = { ...item, ...identity, length: info.size, digest, modified: info.mtimeNs / 100n }
    this.index.put(refreshed)
    return refreshed
  }

  /** The caller has already verified the digest or just measured the file. */
  insert(path: string, size: number, md5: string): Promise<void> {
    return this.closing
      ? Promise.resolve()
      : this.track(this.insertVerified(resolve(path), size, md5))
  }

  private async insertVerified(path: string, expectedSize: number, md5: string): Promise<void> {
    try {
      const size = BigInt(expectedSize)
      const info = await fileInfo(path)
      if (!info || info.size !== size) return
      const format = await this.platform.driveFormat(path)
      const identity = hasSupportedFormat(format)
        ? await this.platform.fileIdentity(path, true)
        : NO_IDENTITY
      this.index.put({
        path, game: this.gameId, ...identity,
        length: size, digest: md5, modified: info.mtimeNs / 100n
      })
    } catch {
      // As upstream, a cache write failure cannot fail the game update.
    }
  }

  deleteFile(path: string): void {
    try {
      this.index.deleteFile(path)
    } catch {
      /* Index maintenance is best effort. */
    }
  }

  deleteFolder(folder: string): void {
    try {
      this.index.deleteFolder(folder)
    } catch {
      /* Index maintenance is best effort. */
    }
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.active.add(task)
    const finish = (): void => { this.active.delete(task) }
    void task.then(finish, finish)
    return task
  }

  close(): Promise<void> {
    this.closing = true
    this.finalizer ??= this.finish()
    return this.finalizer
  }

  private async finish(): Promise<void> {
    while (this.active.size) await Promise.allSettled(this.active)
    try {
      this.index.close()
    } catch {
      /* The verified game files are already complete. */
    } finally {
      await this.platform.close().catch(() => undefined)
    }
  }
}
