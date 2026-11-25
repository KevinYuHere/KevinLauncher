import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import {
  downloadSophonBuild,
  type SophonAsset,
  type SophonBuild,
  type SophonChunk
} from '../src/main/update/sophon'
import { hoyoPortBudget } from '../src/main/update/hoyoNetwork'

// `zlib.zstdCompressSync` only exists on Node 22.15+/24; the fixtures need it, so
// the suite is skipped (rather than failing) on older runtimes.
const zstdCompressSync = (
  zlib as unknown as { zstdCompressSync?: (data: Buffer) => Buffer }
).zstdCompressSync
const hasZstd = typeof zstdCompressSync === 'function'
const zstd = (data: Buffer): Buffer => zstdCompressSync!(data)

// --- tiny proto3 writer matching the reader inside sophon.ts ----------------

function vint(n: number): Buffer {
  const out: number[] = []
  let v = n >>> 0
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
  return Buffer.from(out)
}
const tag = (field: number, wire: number): Buffer => vint((field << 3) | wire)
const fBytes = (field: number, data: Buffer): Buffer =>
  Buffer.concat([tag(field, 2), vint(data.length), data])
const fNum = (field: number, value: number): Buffer => Buffer.concat([tag(field, 0), vint(value)])

function encodeChunk(c: SophonChunk): Buffer {
  return Buffer.concat([
    fBytes(1, Buffer.from(c.name, 'utf8')),
    fNum(3, c.offset),
    fNum(4, c.size),
    fNum(5, c.sizeDecompressed)
  ])
}
function encodeAsset(a: SophonAsset): Buffer {
  const parts = [fBytes(1, Buffer.from(a.name, 'utf8'))]
  for (const c of a.chunks) parts.push(fBytes(2, encodeChunk(c)))
  parts.push(fNum(4, a.size))
  parts.push(fBytes(5, Buffer.from(a.md5, 'utf8')))
  return Buffer.concat(parts)
}
const encodeManifest = (assets: SophonAsset[]): Buffer =>
  Buffer.concat(assets.map((a) => fBytes(1, encodeAsset(a))))

// --- shared helpers ---------------------------------------------------------

const md5 = (data: Buffer): string => createHash('md5').update(data).digest('hex')
const chunkBody = (name: string): Buffer => Buffer.from(name.padEnd(4, '0').slice(0, 4))

function makeAsset(name: string, chunkNames: string[]): SophonAsset {
  let offset = 0
  const chunks: SophonChunk[] = []
  for (const c of chunkNames) {
    chunks.push({
      name: c,
      uncompressedMd5: '',
      compressedMd5: '',
      offset,
      size: zstd(chunkBody(c)).length,
      sizeDecompressed: 4
    })
    offset += 4
    chunkBodies.set(c, chunkBody(c))
  }
  const content = Buffer.concat(chunkNames.map(chunkBody))
  return { name, size: content.length, md5: md5(content), chunks }
}
const expectedContent = (chunkNames: string[]): Buffer =>
  Buffer.concat(chunkNames.map(chunkBody))

let baseUrl = ''
let server: Server

// mutable server state, reset per test
let manifestZstd: Buffer = Buffer.alloc(0)
let chunkBodies = new Map<string, Buffer>()
let chunkReqs = new Map<string, number>()
let corruptOnce = new Set<string>()
let drip = new Set<string>()
let inFlight = 0
let maxInFlight = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '')
    if (url.startsWith('/manifest/')) {
      res.end(manifestZstd)
      return
    }
    const name = url.slice('/chunk/'.length)
    chunkReqs.set(name, (chunkReqs.get(name) ?? 0) + 1)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    setTimeout(() => {
      inFlight--
      const body = chunkBodies.get(name)
      if (!body) {
        res.statusCode = 404
        res.end('missing')
        return
      }
      if (corruptOnce.has(name)) {
        corruptOnce.delete(name)
        res.end(zstd(Buffer.from('corrupt')))
        return
      }
      const encoded = zstd(body)
      if (drip.has(name)) {
        res.write(encoded.subarray(0, 5))
        setTimeout(() => res.end(encoded.subarray(5)), 100)
      } else res.end(encoded)
    }, 10)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'object' && address) baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  // The CDN negotiation itself is exercised in hoyoNetwork.test.ts.
  Atomics.store(new BigUint64Array(hoyoPortBudget), 0, (BigInt(Date.now() + 60_000) << 4n) + 10n)
  chunkBodies = new Map()
  chunkReqs = new Map()
  corruptOnce = new Set()
  drip = new Set()
  inFlight = 0
  maxInFlight = 0
})

function makeBuild(): SophonBuild {
  return {
    buildId: 'test-build',
    tag: 'test',
    categories: [
      {
        categoryId: 'cat',
        categoryName: 'cat',
        matchingField: 'game',
        manifestId: 'manifest-1',
        manifestUrlPrefix: `${baseUrl}/manifest`,
        manifestCompression: 1,
        manifestSuffix: '',
        chunkUrlPrefix: `${baseUrl}/chunk`,
        chunkCompression: 1,
        chunkSuffix: '',
        compressedSize: 0
      }
    ]
  }
}

const temporaryDirs = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporaryDirs].map(dir => fs.rm(dir, { recursive: true, force: true })))
  temporaryDirs.clear()
})

async function tmpDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'sophon-test-')))
  temporaryDirs.add(dir)
  return dir
}
const read = (p: string): Promise<Buffer> => fs.readFile(p)

describe.skipIf(!hasZstd)('downloadSophonBuild', () => {
  it('downloads different files in parallel and handles each file in chunk order', async () => {
    const one = makeAsset('a.bin', ['a1', 'a2', 'a3'])
    const two = makeAsset('b.bin', ['b1', 'b2', 'b3'])
    manifestZstd = zstd(encodeManifest([one, two]))
    const dir = await tmpDir()
    await downloadSophonBuild(makeBuild(), dir, () => {})
    expect(md5(await read(join(dir, 'a.bin')))).toBe(one.md5)
    expect(md5(await read(join(dir, 'b.bin')))).toBe(two.md5)
    expect(maxInFlight).toBe(2)
    const calls = [...chunkReqs.keys()]
    expect(calls.filter(id => id.startsWith('a'))).toEqual(['a1', 'a2', 'a3'])
    expect(calls.filter(id => id.startsWith('b'))).toEqual(['b1', 'b2', 'b3'])
  })

  it.each([false, true])('reports received bytes before a chunk completes, cacheOnly=%s', async cacheOnly => {
    const asset = makeAsset('progress.bin', ['slow'])
    manifestZstd = zstd(encodeManifest([asset]))
    drip.add('slow')
    const dest = await tmpDir()
    const seen: number[] = []
    await downloadSophonBuild(makeBuild(), dest, p => seen.push(p.downloaded), undefined,
      { cacheDir: join(dest, 'chunk'), cacheOnly })
    expect(seen).toContain(5)
    expect(seen.at(-1)).toBe(asset.chunks[0].size)
  })

  it('credits bytes copied from an older file while assembling a changed file', async () => {
    const dest = await tmpDir()
    const asset = makeAsset('new', ['keep', 'next'])
    asset.chunks[0].uncompressedMd5 = md5(chunkBody('keep'))
    await fs.writeFile(join(dest, 'old'), chunkBody('keep'))
    const build = makeBuild()
    const seen: [number, number][] = []
    await downloadSophonBuild(build, dest, p => seen.push([p.downloaded, p.total]), undefined, {
      originDir: dest, prepared: {
        files: [{ category: build.categories[0], asset }],
        oldChunks: new Map([['keep', { file: 'old', offset: 0 }]]), oldFiles: new Map()
      }
    })
    const bytes = asset.chunks[1].size
    expect(seen[0]).toEqual([0, bytes])
    expect(seen.at(-1)).toEqual([bytes * 2, bytes * 2])
    expect([...chunkReqs.keys()]).toEqual(['next'])
    expect(await fs.readFile(join(dest, 'new'))).toEqual(expectedContent(['keep', 'next']))
  })

  it('reports monotonically increasing progress up to the total', async () => {
    const asset = makeAsset('p.bin', ['p1', 'p2', 'p3', 'p4'])
    manifestZstd = zstd(encodeManifest([asset]))
    const dest = await tmpDir()
    const seen: number[] = []

    await downloadSophonBuild(makeBuild(), dest, (p) => seen.push(p.downloaded))

    expect(seen.at(-1)).toBe(asset.chunks.reduce((sum, chunk) => sum + chunk.size, 0))
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
  })

  it('retries the asset when a chunk fails its md5 check', async () => {
    const asset = makeAsset('retry.bin', ['r1', 'r2', 'r3'])
    manifestZstd = zstd(encodeManifest([asset]))
    corruptOnce.add('r2')
    const dest = await tmpDir()

    await downloadSophonBuild(makeBuild(), dest, () => {})

    expect(md5(await read(join(dest, 'retry.bin')))).toBe(asset.md5)
    // The whole asset is re-fetched on the second attempt.
    expect(chunkReqs.get('r1')).toBe(2)
    expect(chunkReqs.get('r2')).toBe(2)
  })

  it('throws after exhausting retries on a permanently bad chunk', async () => {
    const asset = makeAsset('bad.bin', ['b1', 'b2'])
    manifestZstd = zstd(encodeManifest([asset]))
    // Always serve corrupt bytes: replace the body with something wrong.
    chunkBodies.set('b1', Buffer.from('XXXX'))
    const dest = await tmpDir()

    await expect(downloadSophonBuild(makeBuild(), dest, () => {})).rejects.toThrow(/校验失败/)
    expect(chunkReqs.get('b1')).toBe(3)
  }, 12_000)

  it('skips unchanged files (resume)', async () => {
    const asset = makeAsset('keep.bin', ['k1', 'k2'])
    manifestZstd = zstd(encodeManifest([asset]))
    const dest = await tmpDir()
    await fs.writeFile(join(dest, 'keep.bin'), expectedContent(['k1', 'k2']))

    await downloadSophonBuild(makeBuild(), dest, () => {}, undefined, { skipUnchanged: true })

    expect(chunkReqs.size).toBe(0)
  })

  it('resumes from the raw chunk cache (pre-download)', async () => {
    const done = makeAsset('done.bin', ['d1', 'd2'])
    const changed = makeAsset('partial.bin', ['p1', 'p2'])
    manifestZstd = zstd(encodeManifest([done, changed]))

    const dest = await tmpDir()
    const cache = await tmpDir()
    // `done.bin` is already installed; `p1` was cached by an earlier run.
    await fs.writeFile(join(dest, 'done.bin'), expectedContent(['d1', 'd2']))
    await fs.writeFile(join(cache, 'p1'), zstd(chunkBody('p1')))

    await downloadSophonBuild(makeBuild(), dest, () => {}, undefined, {
      skipUnchanged: true,
      cacheDir: cache
    })

    expect(md5(await read(join(dest, 'partial.bin')))).toBe(changed.md5)
    // Unchanged file and cached chunk are reused; only `p2` is fetched.
    expect(chunkReqs.has('d1')).toBe(false)
    expect(chunkReqs.has('d2')).toBe(false)
    expect(chunkReqs.has('p1')).toBe(false)
    expect(chunkReqs.get('p2')).toBe(1)
    // A cache without a recorded ownership entry survives assembly.
    expect(await fs.readdir(cache)).toEqual(['p1'])
  })

  it('pre-download only fills the chunk cache (cacheOnly)', async () => {
    const changed = makeAsset('partial.bin', ['p1', 'p2'])
    manifestZstd = zstd(encodeManifest([changed]))
    const dest = await tmpDir()
    const cache = await tmpDir()

    await downloadSophonBuild(makeBuild(), dest, () => {}, undefined, {
      skipUnchanged: true,
      cacheDir: cache,
      cacheOnly: true
    })

    // Both chunks cached, but no game file assembled yet.
    expect((await fs.readdir(cache)).sort()).toEqual(['p1', 'p2'])
    await expect(fs.stat(join(dest, 'partial.bin'))).rejects.toBeTruthy()
  })
})
