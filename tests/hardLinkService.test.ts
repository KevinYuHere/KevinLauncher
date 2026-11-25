import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, parse, sep } from 'node:path'
import { createRequire } from 'node:module'
import { GAME_FILE_CATALOG_NAME } from '../src/shared/paths'
import { GameFileCatalog } from '../src/main/services/gameFileCatalog'
import { HardLinkService } from '../src/main/services/hardLinkService'
import { WindowsFileIdentity, type HardLinkPlatform } from '../src/main/services/windowsFileIdentity'
import { openWritableGameFile } from '../src/main/services/writableGameFile'
import { downloadGameFile, withHoYoNetwork } from '../src/main/update/hoyoNetwork'
import { downloadSophonBuild, type PreparedChunkFiles, type SophonBuild } from '../src/main/update/sophon'
import { startHoyoHttpFixture } from './fixtures/hoyoHttpFixture'

const data = Buffer.alloc(2048, 0x11)
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
const md5 = (buffer: Buffer): string => createHash('md5').update(buffer).digest('hex')
const digest = md5(data)
const oldWriteTime = 17800000000000000n
let root: string
let catalog: GameFileCatalog
const cleanup: string[] = []
const active: HardLinkService[] = []

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'kevin-hardlink-')))
  cleanup.push(root)
  catalog = new GameFileCatalog(root)
})

describe('Sophon file index integration', () => {
  it.each([false, true])('shares verified content before HTTP (cacheOnly=%s)', async (cacheOnly) => {
    const fixture = await startHoyoHttpFixture()
    try {
      fixture.route('/chunk/part', { body: data })
      const category = {
        categoryId: '1', categoryName: 'Game', matchingField: 'game',
        manifestId: '', manifestUrlPrefix: '', manifestCompression: 0, manifestSuffix: '',
        chunkUrlPrefix: fixture.url + '/chunk', chunkCompression: 0, chunkSuffix: '',
        compressedSize: data.length
      }
      const build: SophonBuild = { buildId: 'fixture', tag: '2.0.0', categories: [category] }
      const prepared: PreparedChunkFiles = {
        oldChunks: new Map(), oldFiles: new Map(),
        files: [{ category, asset: {
          name: 'asset.bin', md5: digest, size: data.length, chunks: [{
            name: 'part', offset: 0, size: data.length, sizeDecompressed: data.length,
            compressedMd5: digest, uncompressedMd5: digest
          }]
        } }]
      }
      const stages = [join(root, 'install A'), join(root, 'install B')]
      const completed = vi.fn()
      let firstRequests: typeof fixture.requests = []
      for (const [i, dir] of stages.entries()) {
        const links = createService(platform(), `game-${i}`)
        const signal = new AbortController().signal
        await withHoYoNetwork(root, 'runner', () =>
          downloadSophonBuild(build, dir, completed, signal, {
            prepared, cacheOnly, cacheDir: cacheOnly ? join(dir, 'chunk') : undefined, links, skipUnchanged: true
          })
        )
        await links.close()
        if (i === 0) firstRequests = fixture.requests.slice()
      }
      const relative = cacheOnly ? join('chunk', 'part') : 'asset.bin'
      const [source, target] = stages.map((dir) => join(dir, relative))
      expect(await fs.readFile(source)).toEqual(data)
      expect(await fs.readFile(target)).toEqual(data)
      expect((await fs.stat(target)).nlink).toBe(2)
      expect(firstRequests).toContainEqual(expect.objectContaining({ method: 'GET', path: '/chunk/part' }))
      expect(fixture.requests).toEqual(firstRequests)
      expect(completed).toHaveBeenLastCalledWith(expect.objectContaining({
        downloaded: data.length, total: data.length
      }))
      if (cacheOnly) await expect(fs.access(join(stages[1], 'asset.bin'))).rejects.toMatchObject({ code: 'ENOENT' })

      // Replacing a hard-linked cache/final file must only modify this installation.
      const next = Buffer.alloc(data.length, 0x49)
      const nextDigest = md5(next)
      fixture.route('/chunk/part', { body: next })
      const entry = prepared.files[0].asset
      entry.md5 = nextDigest
      entry.chunks[0].compressedMd5 = nextDigest
      entry.chunks[0].uncompressedMd5 = nextDigest
      const revised = createService()
      await withHoYoNetwork(root, 'runner', () =>
        downloadSophonBuild(build, stages[1], completed, undefined, {
          prepared, cacheOnly, cacheDir: cacheOnly ? join(stages[1], 'chunk') : undefined, links: revised,
          skipUnchanged: true
        })
      )
      await revised.close()
      expect(await fs.readFile(source)).toEqual(data)
      expect(await fs.readFile(target)).toEqual(next)
      expect((await fs.stat(target)).ino).not.toBe((await fs.stat(source)).ino)
    } finally {
      await fixture.close()
    }
  })

  it('downloads and truncates previously linked files without changing their donor', async () => {
    const fixture = await startHoyoHttpFixture()
    try {
      fixture.route('/component', { body: '123456' })
      const donor = await write(join(root, 'parent-install', 'donor.zip'), Buffer.from('123'))
      const dir = join(root, 'new-install')
      await fs.mkdir(dir, { recursive: true })
      const resume = join(dir, 'component.zip')
      const truncate = join(dir, 'plugin.zip')
      await fs.link(donor, resume)
      await fs.link(donor, truncate)
      await withHoYoNetwork(root, 'runner', async () => {
        await downloadGameFile({ url: fixture.url + '/component', path: resume, size: 6 })
        expect(fixture.requests).toContainEqual(expect.objectContaining({ range: 'bytes=3-' }))
        const requestCount = fixture.requests.length
        await downloadGameFile({ url: fixture.url + '/no-network', path: truncate, size: 2 })
        expect(fixture.requests).toHaveLength(requestCount)
      })
      expect(await fs.readFile(donor, 'utf8')).toBe('123')
      expect(await fs.readFile(resume, 'utf8')).toBe('123456')
      expect(await fs.readFile(truncate, 'utf8')).toBe('12')
    } finally {
      await fixture.close()
    }
  })
})

afterEach(async () => {
  await Promise.all(active.splice(0).map((service) => service.close()))
  catalog.close()
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })))
})

const unrelatedPath = (): string => join(root, '__target_outside_test__')

function platform(format = 'NTFS') {
  return {
    driveFormat: vi.fn(async () => format),
    fileIdentity: vi.fn(async (path: string) => {
      const info = await fs.stat(path, { bigint: true })
      return { volumeId: 8n, lowId: info.ino, highId: -9007199254740993n }
    }),
    close: vi.fn(async () => undefined)
  } satisfies HardLinkPlatform
}

function createService(system: HardLinkPlatform = platform(), gameId = '1Z8W5NHUQb'): HardLinkService {
  const service = new HardLinkService(root, gameId, system)
  active.push(service)
  return service
}

function seed(path: string, lastWriteTime: bigint, hash = digest, size = data.length): void {
  catalog.put({
    path,
    game: '64kMb5iAWu',
    volumeId: 0n,
    lowId: 0n,
    highId: 0n,
    length: BigInt(size),
    digest: hash,
    modified: lastWriteTime
  })
}

async function write(path: string, buffer = data): Promise<string> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, buffer)
  return path
}

describe('Starward file index and hard links', () => {
  it('uses its own WAL catalog and rejects sub-1 KiB sizes before filesystem probing', async () => {
    const native = platform('exFAT')
    const service = createService(native)
    const target = join(root, 'target')
    expect(await service.tryLink(target, 1023, digest)).toBe(false)
    expect(native.driveFormat).not.toHaveBeenCalled()
    expect(await service.tryLink(target, 1024, digest)).toBe(false)
    expect(native.driveFormat).toHaveBeenCalledOnce()
    expect(native.driveFormat).toHaveBeenCalledWith(target)

    const checked = await write(join(root, 'source'))
    const unrelatedDatabase = await write(join(root, 'GameFile.db'), Buffer.from('unrelated file'))
    await service.insert(checked, data.length, digest)
    const rows = catalog.candidates(unrelatedPath(), BigInt(data.length), digest)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ volumeId: 0n, lowId: 0n, highId: 0n })
    expect(native.fileIdentity).not.toHaveBeenCalled()
    const anotherConnection = new DatabaseSync(catalog.path)
    try {
      expect(anotherConnection.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
      expect(anotherConnection.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
      expect(catalog.path).toBe(join(root, GAME_FILE_CATALOG_NAME))
      expect(await fs.readFile(unrelatedDatabase, 'utf8')).toBe('unrelated file')
    } finally {
      anotherConnection.close()
    }
  })

  it('prunes missing donors, refreshes stale candidates, and uses the earliest valid donor from another instance', async () => {
    const source = join(root, '第一份安装')
    const target = join(root, 'second', 'chunk', 'target')
    const stale = join(source, 'absent')
    const changedSize = await write(join(source, 'changed-size'), Buffer.alloc(1024, 0x71))
    const changedData = Buffer.alloc(data.length, 0x22)
    const changedHash = await write(join(source, 'changed-digest'), changedData)
    const upperCase = await write(join(source, 'different-digest-case'))
    const earlier = await write(join(source, 'earlier'))
    const later = await write(join(source, 'later'))
    await write(target, Buffer.from('original target'))
    await write(target + '.link', Buffer.from('old temporary link'))
    seed(stale, oldWriteTime)
    seed(changedSize, oldWriteTime + 1n)
    seed(changedHash, oldWriteTime + 2n)
    seed(upperCase, oldWriteTime + 3n, digest.toUpperCase())
    seed(earlier, oldWriteTime + 4n)
    seed(later, oldWriteTime + 5n)

    const native = platform()
    const service = createService(native)
    expect(await service.tryLink(target, data.length, digest)).toBe(true)
    await service.close()
    expect(await fs.readFile(target)).toEqual(data)
    expect(await fs.readFile(target + '.link', 'utf8')).toBe('old temporary link')
    expect((await fs.stat(earlier, { bigint: true })).ino).toBe((await fs.stat(target, { bigint: true })).ino)
    expect((await fs.stat(later, { bigint: true })).ino).not.toBe((await fs.stat(target, { bigint: true })).ino)
    const before = catalog.candidates(unrelatedPath(), BigInt(data.length), digest)
    expect(before.map((candidate) => candidate.path)).not.toContain(stale)
    expect(before.map((candidate) => candidate.path)).not.toContain(upperCase)
    expect(catalog.candidates(unrelatedPath(), BigInt(changedData.length), md5(changedData))).toMatchObject([{
      path: changedHash
    }])
    expect(catalog.candidates(unrelatedPath(), 1024n, md5(Buffer.alloc(1024, 0x71)))).toMatchObject([{
      path: changedSize
    }])
    expect(before.find((entry) => entry.path === target)).toMatchObject({
      game: '1Z8W5NHUQb', highId: -9007199254740993n, volumeId: 8n
    })
    expect(native.fileIdentity.mock.calls.map(([path]) => path)).not.toContain(later)
    expect(native.close).toHaveBeenCalledOnce()
  })

  it('leaves existing files intact and cleans up its temporary link if replacement fails', async () => {
    const source = await write(join(root, 'donor.bin'))
    const parent = join(root, 'install')
    const target = join(parent, 'occupied')
    await fs.mkdir(target, { recursive: true })
    await write(join(target, 'existing.txt'), Buffer.from('keep'))
    const unrelated = await write(target + '.link', Buffer.from('unrelated file'))
    seed(source, oldWriteTime)
    const service = createService()
    expect(await service.tryLink(target, data.length, digest)).toBe(false)
    expect(await fs.readFile(join(target, 'existing.txt'), 'utf8')).toBe('keep')
    expect(await fs.readFile(unrelated, 'utf8')).toBe('unrelated file')
    expect((await fs.readdir(parent)).sort()).toEqual(['occupied', 'occupied.link'])
    expect((await fs.stat(source)).nlink).toBe(1)
  })

  it('keeps the resumable prefix when opening an existing hard-linked file for writing', async () => {
    const source = await write(join(root, 'donor.zip'), Buffer.from('123'))
    const target = join(root, 'component.zip')
    await fs.link(source, target)
    const handle = await openWritableGameFile(target)
    try {
      expect(await fs.readFile(target, 'utf8')).toBe('123')
      await handle.write(Buffer.from('456'), 0, 3, 3)
    } finally {
      await handle.close()
    }
    expect(await fs.readFile(target, 'utf8')).toBe('123456')
    expect(await fs.readFile(source, 'utf8')).toBe('123')
    expect((await fs.readdir(root)).sort()).toEqual(['component.zip', 'donor.zip'])
  })

  it('allows exactly 1 KiB on ReFS and clears index rows by exact file or folder path', async () => {
    const source = join(root, 'source')
    const cache = join(root, 'cache')
    const untouched = join(root, 'cache-next', 'outside')
    const boundary = Buffer.alloc(1024, 0x63)
    const boundaryDigest = md5(boundary)
    await write(source, boundary)
    await write(untouched, boundary)
    const service = createService(platform('ReFS'))
    await service.insert(source, boundary.length, boundaryDigest)
    await service.insert(untouched, boundary.length, boundaryDigest)
    const target = join(cache, 'entry')
    expect(await service.tryLink(target, boundary.length, boundaryDigest)).toBe(true)
    await service.close()

    const cleanupService = createService()
    cleanupService.deleteFolder(cache)
    cleanupService.deleteFile(source)
    const remaining = catalog.candidates(unrelatedPath(), 1024n, boundaryDigest)
    expect(remaining.map((item) => item.path)).toEqual([untouched])
  })

  it.each([
    ['install_CN', 'installXCN'],
    ['install%CN', 'install-extra-CN'],
    ['install!_CN', 'install!XCN']
  ])('cleans only the literal installation directory %s', (name, neighboring) => {
    const target = join(root, name, 'chunk')
    const other = join(root, neighboring, 'chunk', 'donor')
    seed(join(target, 'file'), oldWriteTime)
    seed(join(target, 'nested', 'file'), oldWriteTime + 1n)
    seed(other, oldWriteTime + 2n)

    catalog.deleteFolder(target + sep)

    expect(catalog.candidates(unrelatedPath(), BigInt(data.length), digest)
      .map((candidate) => candidate.path)).toEqual([other])
  })

  it('returns false on cancellation inside candidate hashing and leaves target untouched', async () => {
    const source = await write(join(root, 'source'))
    const target = await write(join(root, 'target'), Buffer.alloc(2, 1))
    seed(source, oldWriteTime)
    const native = platform()
    const service = createService(native)
    expect(await service.tryLink(target, data.length, digest, AbortSignal.abort())).toBe(false)
    expect(await fs.readFile(target)).toEqual(Buffer.alloc(2, 1))
    expect(native.fileIdentity).not.toHaveBeenCalled()
  })

  const hasSecondDrive = process.platform === 'win32' && parse(tmpdir()).root !== parse(process.cwd()).root
  it.skipIf(!hasSecondDrive)('does not refresh existing donors from another drive root', async () => {
    const scratch = await fs.mkdtemp(join(process.cwd(), 'tests', 'fixtures', '.kevin-hardlink-test-'))
    cleanup.push(scratch)
    const otherDrive = await write(join(scratch, 'donor'))
    const target = join(root, 'target')
    seed(otherDrive, oldWriteTime)
    const native = platform()
    const service = createService(native)
    expect(await service.tryLink(target, data.length, digest)).toBe(false)
    expect(native.fileIdentity).not.toHaveBeenCalled()
    expect(catalog.candidates(unrelatedPath(), BigInt(data.length), digest)).toMatchObject([
      { path: otherDrive, modified: oldWriteTime }
    ])
    await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe.skipIf(process.platform !== 'win32')('Windows file identity transport', () => {
  it('uses Win32 file identity for a native hard link, including Unicode paths', async () => {
    const original = await write(join(root, '源 文件.bin'))
    const linked = join(root, '链接 文件.bin')
    await fs.link(original, linked)
    const system = new WindowsFileIdentity()
    try {
      expect(await system.driveFormat(original)).toMatch(/^(?:NTFS|ReFS)$/)
      const [source, target] = await Promise.all([
        system.fileIdentity(original, true),
        system.fileIdentity(linked, false)
      ])
      expect(source).toEqual(target)
      expect(source.volumeId).not.toBe(0n)
      expect(source.lowId !== 0n || source.highId !== 0n).toBe(true)
    } finally {
      await system.close()
    }
  }, 20000)

  it('reopens the app-owned catalog across tasks and reuses the file with real Windows identities', async () => {
    const source = await write(join(root, '安装一', '源.dat'))
    const target = join(root, '安装二', '目标.dat')
    const first = createService(new WindowsFileIdentity(), '64kMb5iAWu')
    await first.insert(source, data.length, digest)
    await first.close()
    const second = createService(new WindowsFileIdentity())
    expect(await second.tryLink(target, data.length, digest)).toBe(true)
    await second.close()
    const files = catalog.candidates(unrelatedPath(), BigInt(data.length), digest)
    const expected = files.find((file) => file.path === source)
    const result = files.find((file) => file.path === target)
    expect(expected?.volumeId).not.toBe(0n)
    expect(result).toMatchObject({
      volumeId: expected?.volumeId, lowId: expected?.lowId, highId: expected?.highId
    })
    expect((await fs.stat(target)).nlink).toBe(2)
  }, 30000)
})
