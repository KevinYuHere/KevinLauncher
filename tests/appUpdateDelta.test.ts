import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyAppDelta,
  buildAppDelta,
  inventoryAppTree,
  type AppTreeInventory
} from '../src/main/services/appUpdateDelta'

const FROM = '3.0.0-beta.11'
const TO = '3.0.0-beta.12'

interface EncodedFile {
  p: string
  s: number
  h: string
  r?: string
  d?: string
}

interface EncodedDelta {
  format: number
  fromVersion: string
  toVersion: string
  appSize: number
  files: EncodedFile[]
}

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'kl-app-delta-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function sha(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

async function writeTree(name: string, files: Record<string, string | Buffer>): Promise<string> {
  const directory = join(root, name)
  for (const [path, data] of Object.entries(files)) {
    const full = join(directory, ...path.split('/'))
    await fs.mkdir(dirname(full), { recursive: true })
    await fs.writeFile(full, data)
  }
  await fs.mkdir(directory, { recursive: true })
  return directory
}

async function readTree(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const walk = async (current: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full, relative)
      } else if (entry.isFile()) {
        result[relative] = (await fs.readFile(full)).toString('base64')
      }
    }
  }
  await walk(directory, '')
  return result
}

function inventorySize(inventory: AppTreeInventory): number {
  return inventory.files.reduce((sum, file) => sum + file.size, 0)
}

function changedFile(path: string, data: string | Buffer): Record<string, unknown> {
  const bytes = Buffer.from(data)
  return {
    p: path,
    s: bytes.length,
    h: sha(bytes),
    d: bytes.toString('base64')
  }
}

function deltaFor(files: Record<string, unknown>[], overrides: Record<string, unknown> = {}) {
  return {
    format: 1,
    fromVersion: FROM,
    toVersion: TO,
    appSize: files.reduce((sum, file) => sum + Number(file.s), 0),
    files,
    ...overrides
  }
}

function gzipDelta(payload: unknown): Buffer {
  const archive = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 })
  archive[9] = 0xff
  return archive
}

async function saveArchive(name: string, payload: unknown): Promise<string> {
  const path = join(root, name)
  await fs.writeFile(path, gzipDelta(payload))
  return path
}

describe('application delta updates', () => {
  it('builds a compact deterministic delta, reuses content and verifies the applied tree', async () => {
    const shared = randomBytes(24 * 1024)
    const unchanged = randomBytes(8 * 1024)
    const oldIndex = Buffer.from('old entry point\n')
    const newIndex = Buffer.from('new entry point\n')
    const oldPackage = Buffer.from(JSON.stringify({ version: FROM }))
    const newPackage = Buffer.from(JSON.stringify({ version: TO }))
    const baseRoot = await writeTree('base', {
      'package.json': oldPackage,
      'out/main/index.js': oldIndex,
      'out/main/unchanged.js': unchanged,
      'resources/shared.bin': shared,
      'resources/old-only.bin': Buffer.from('removed in target'),
      'assets/empty.bin': Buffer.alloc(0)
    })
    const targetRoot = await writeTree('target', {
      'package.json': newPackage,
      'out/main/index.js': newIndex,
      'out/main/unchanged.js': unchanged,
      'resources/renamed/shared.bin': shared,
      'resources/新文件.txt': Buffer.from('only in target 中文'),
      'assets/empty.bin': Buffer.alloc(0)
    })
    const baseInventory = await inventoryAppTree(baseRoot, FROM)
    const targetInventory = await inventoryAppTree(targetRoot, TO)
    const appSize = inventorySize(targetInventory)

    const first = await buildAppDelta(baseInventory, targetRoot, TO)
    const second = await buildAppDelta(baseInventory, targetRoot, TO)
    expect(first.equals(second)).toBe(true)
    expect([first[0], first[1], first[9]]).toEqual([0x1f, 0x8b, 0xff])
    expect(first.length).toBeLessThan(4096)

    const decoded = JSON.parse(gunzipSync(first).toString('utf8')) as EncodedDelta
    expect(decoded).toMatchObject({ format: 1, fromVersion: FROM, toVersion: TO, appSize })
    expect(decoded.files).toHaveLength(targetInventory.files.length)
    const byPath = new Map(decoded.files.map(file => [file.p, file]))
    expect(byPath.get('out/main/unchanged.js')).not.toHaveProperty('d')
    expect(byPath.get('assets/empty.bin')).not.toHaveProperty('d')
    const moved = byPath.get('resources/renamed/shared.bin')
    expect(moved?.r).toBe('resources/shared.bin')
    expect(moved).not.toHaveProperty('d')
    const changed = byPath.get('out/main/index.js')
    expect(changed?.d).toBe(newIndex.toString('base64'))
    expect(byPath.has('resources/old-only.bin')).toBe(false)

    const archivePath = join(root, 'delta.json.gz')
    await fs.writeFile(archivePath, first)
    const prepared = join(root, 'prepared')
    const baseBefore = await readTree(baseRoot)
    const progress: [number, number][] = []
    await applyAppDelta(
      archivePath, baseRoot, prepared, FROM, TO, appSize,
      (done, total) => progress.push([done, total])
    )

    expect(await readTree(prepared)).toEqual(await readTree(targetRoot))
    expect(await readTree(baseRoot)).toEqual(baseBefore)
    expect(await inventoryAppTree(prepared, TO)).toEqual(targetInventory)
    expect(progress[0]).toEqual([0, appSize])
    expect(progress.at(-1)).toEqual([appSize, appSize])
    for (let index = 1; index < progress.length; index++) {
      expect(progress[index][0]).toBeGreaterThanOrEqual(progress[index - 1][0])
      expect(progress[index][1]).toBe(appSize)
    }
  })

  it('embeds complete content when a file keeps its length but changes', async () => {
    const baseRoot = await writeTree('base-same-length', { 'data.txt': 'AAAA' })
    const targetRoot = await writeTree('target-same-length', { 'data.txt': 'BBBB' })
    const baseInventory = await inventoryAppTree(baseRoot, FROM)
    const delta = await buildAppDelta(baseInventory, targetRoot, TO)
    const decoded = JSON.parse(gunzipSync(delta).toString('utf8')) as EncodedDelta
    expect(decoded.files).toEqual([{
      p: 'data.txt',
      s: 4,
      h: sha('BBBB'),
      d: Buffer.from('BBBB').toString('base64')
    }])

    const archivePath = join(root, 'same-length.json.gz')
    await fs.writeFile(archivePath, delta)
    await applyAppDelta(archivePath, baseRoot, join(root, 'prepared-same-length'), FROM, TO, 4)
    expect(await fs.readFile(join(root, 'prepared-same-length', 'data.txt'), 'utf8')).toBe('BBBB')
  })

  it('rejects a same-size corrupt base and removes partial prepared files', async () => {
    const unchanged = randomBytes(4096)
    const baseRoot = await writeTree('base-corrupt', {
      'a-first.js': 'old content',
      'z-last.bin': unchanged
    })
    const targetRoot = await writeTree('target-corrupt', {
      'a-first.js': 'new content',
      'z-last.bin': unchanged
    })
    const baseInventory = await inventoryAppTree(baseRoot, FROM)
    const targetInventory = await inventoryAppTree(targetRoot, TO)
    const delta = await buildAppDelta(baseInventory, targetRoot, TO)
    const archivePath = join(root, 'corrupt.json.gz')
    await fs.writeFile(archivePath, delta)

    // Keep the length unchanged so only the required digest check can catch it.
    const corrupt = Buffer.alloc(unchanged.length, 0x5a)
    await fs.writeFile(join(baseRoot, 'z-last.bin'), corrupt)
    const prepared = join(root, 'prepared-corrupt')
    await expect(applyAppDelta(
      archivePath, baseRoot, prepared, FROM, TO, inventorySize(targetInventory)
    )).rejects.toThrow(/已损坏/)
    expect(await readTree(prepared)).toEqual({})
    expect(await fs.readdir(prepared)).toEqual([])
    expect(await fs.readFile(join(baseRoot, 'z-last.bin'))).toEqual(corrupt)
  })

  it('rejects a missing reused base file without leaving target files', async () => {
    const content = Buffer.from('needed from the old version')
    const baseRoot = await writeTree('base-missing', { 'payload.bin': content })
    const targetRoot = await writeTree('target-missing', { 'payload.bin': content })
    const baseInventory = await inventoryAppTree(baseRoot, FROM)
    const delta = await buildAppDelta(baseInventory, targetRoot, TO)
    const archivePath = join(root, 'missing.json.gz')
    await fs.writeFile(archivePath, delta)
    await fs.rm(join(baseRoot, 'payload.bin'))

    const prepared = join(root, 'prepared-missing')
    await expect(applyAppDelta(
      archivePath, baseRoot, prepared, FROM, TO, content.length
    )).rejects.toThrow(/缺失|普通文件/)
    expect(await readTree(prepared)).toEqual({})
  })

  it('rejects noncanonical, reserved, case-duplicate and colliding target paths', async () => {
    const baseRoot = await writeTree('base-paths', { 'base.txt': 'base' })
    const cases: { payload: unknown; error: RegExp }[] = [
      { payload: deltaFor([changedFile('../escape.txt', 'x')]), error: /相对路径/ },
      { payload: deltaFor([changedFile('C:/drive.txt', 'x')]), error: /相对路径/ },
      { payload: deltaFor([changedFile('folder\\file.txt', 'x')]), error: /相对路径/ },
      { payload: deltaFor([changedFile('folder/CON.txt', 'x')]), error: /保留名称/ },
      { payload: deltaFor([changedFile('folder/name.txt ', 'x')]), error: /Windows/ },
      {
        payload: deltaFor([changedFile('A.txt', 'a'), changedFile('a.txt', 'b')]),
        error: /重复文件/
      },
      {
        payload: deltaFor([changedFile('conflict', 'a'), changedFile('conflict/b.txt', 'b')]),
        error: /路径冲突/
      }
    ]

    for (let index = 0; index < cases.length; index++) {
      const testCase = cases[index]
      const archivePath = join(root, `unsafe-${index}.json.gz`)
      await fs.writeFile(archivePath, gzipDelta(testCase.payload))
      const prepared = join(root, `prepared-unsafe-${index}`)
      await expect(applyAppDelta(
        archivePath, baseRoot, prepared, FROM, TO, Number((testCase.payload as { appSize: number }).appSize)
      )).rejects.toThrow(testCase.error)
      await expect(fs.readdir(prepared)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('checks exact versions, expected size, content digests and a valid gzip payload', async () => {
    const baseRoot = await writeTree('base-metadata', { 'base.txt': 'base' })
    const payload = deltaFor([changedFile('new.txt', 'new')])
    const archivePath = await saveArchive('metadata.json.gz', payload)
    const prepared = join(root, 'prepared-metadata')

    await expect(applyAppDelta(
      archivePath, baseRoot, prepared, '3.0.0-beta.10', TO, 3
    )).rejects.toThrow(/源版本/)
    await expect(applyAppDelta(
      archivePath, baseRoot, prepared, FROM, '3.0.0-beta.13', 3
    )).rejects.toThrow(/目标版本/)
    await expect(applyAppDelta(
      archivePath, baseRoot, prepared, FROM, TO, 4
    )).rejects.toThrow(/应用大小与更新清单不一致/)

    const badHash = deltaFor([{ ...changedFile('new.txt', 'new'), h: '0'.repeat(64) }])
    const badHashPath = await saveArchive('metadata-bad-hash.json.gz', badHash)
    await expect(applyAppDelta(
      badHashPath, baseRoot, prepared, FROM, TO, 3
    )).rejects.toThrow(/校验失败/)
    expect(await fs.readdir(prepared)).toEqual([])

    const invalidGzip = join(root, 'invalid.json.gz')
    await fs.writeFile(invalidGzip, Buffer.from('this is not gzip'))
    await expect(applyAppDelta(
      invalidGzip, baseRoot, join(root, 'prepared-invalid-gzip'), FROM, TO, 3
    )).rejects.toThrow(/无法解压/)
  })

  it('validates a supplied base inventory before building', async () => {
    const targetRoot = await writeTree('target-base-validation', { 'one.txt': 'x' })
    const valid = { path: 'one.txt', size: 1, sha256: sha('x') }
    const cases: { base: unknown; error: RegExp }[] = [
      { base: null, error: /格式无效/ },
      { base: { version: 'not a version', files: [] }, error: /版本无效/ },
      {
        base: { version: FROM, files: [valid, { ...valid, path: 'ONE.txt' }] },
        error: /重复文件/
      },
      {
        base: { version: FROM, files: [{ ...valid, path: '../one.txt' }] },
        error: /相对路径/
      },
      {
        base: { version: FROM, files: [{ ...valid, sha256: 'bad' }] },
        error: /校验值无效/
      }
    ]
    for (const testCase of cases) {
      await expect(buildAppDelta(testCase.base, targetRoot, TO)).rejects.toThrow(testCase.error)
    }
  })

  it.skipIf(process.platform === 'win32')('rejects symlinked files in the old application tree', async () => {
    const content = Buffer.from('linked old content')
    const baseRoot = await writeTree('base-symlink', { 'linked.bin': content })
    const targetRoot = await writeTree('target-symlink', { 'linked.bin': content })
    const baseInventory = await inventoryAppTree(baseRoot, FROM)
    const delta = await buildAppDelta(baseInventory, targetRoot, TO)
    const archivePath = join(root, 'symlink.json.gz')
    await fs.writeFile(archivePath, delta)

    const outside = join(root, 'outside.bin')
    await fs.writeFile(outside, content)
    const linked = join(baseRoot, 'linked.bin')
    await fs.rm(linked)
    await fs.symlink(outside, linked)
    await expect(inventoryAppTree(baseRoot, FROM)).rejects.toThrow(/符号链接/)
    const prepared = join(root, 'prepared-symlink')
    await expect(applyAppDelta(
      archivePath, baseRoot, prepared, FROM, TO, content.length
    )).rejects.toThrow(/符号链接|普通文件/)
    expect(await readTree(prepared)).toEqual({})
  })
})
