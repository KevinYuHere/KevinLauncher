import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  downloadSophonBuild,
  type SophonAsset,
  type SophonBuild,
  type SophonChunk
} from '../src/main/update/sophon'

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
    chunks.push({ name: c, offset, size: 4, sizeDecompressed: 4 })
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
let manifestZstd = Buffer.alloc(0)
let chunkBodies = new Map<string, Buffer>()
let chunkReqs = new Map<string, number>()
let corruptOnce = new Set<string>()
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
        res.end(zstdCompressSync(Buffer.from('corrupt')))
        return
      }
      res.end(zstdCompressSync(body))
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
  chunkBodies = new Map()
  chunkReqs = new Map()
  corruptOnce = new Set()
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
        manifestId: 'manifest-1',
        manifestUrlPrefix: `${baseUrl}/manifest`,
        chunkUrlPrefix: `${baseUrl}/chunk`,
        compressedSize: 0
      }
    ]
  }
}

const tmpDir = (): Promise<string> => fs.mkdtemp(join(tmpdir(), 'sophon-test-'))
const read = (p: string): Promise<Buffer> => fs.readFile(p)

describe('downloadSophonBuild', () => {
  it('downloads chunks concurrently and assembles the asset', async () => {
    const names = Array.from({ length: 40 }, (_, i) => `ch${String(i).padStart(3, '0')}`)
    const asset = makeAsset('big.bin', names)
    manifestZstd = zstdCompressSync(encodeManifest([asset]))
    const dest = await tmpDir()

    await downloadSophonBuild(makeBuild(), dest, () => {})

    expect(md5(await read(join(dest, 'big.bin')))).toBe(asset.md5)
    // Many chunks were in flight at the same time => concurrent (multi-threaded) batches.
    expect(maxInFlight).toBeGreaterThan(1)
  })

  it('reports monotonically increasing progress up to the total', async () => {
    const asset = makeAsset('p.bin', ['p1', 'p2', 'p3', 'p4'])
    manifestZstd = zstdCompressSync(encodeManifest([asset]))
    const dest = await tmpDir()
    const seen: number[] = []

    await downloadSophonBuild(makeBuild(), dest, (p) => seen.push(p.downloaded))

    expect(seen.at(-1)).toBe(asset.size)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
  })

  it('retries the asset when a chunk fails its md5 check', async () => {
    const asset = makeAsset('retry.bin', ['r1', 'r2', 'r3'])
    manifestZstd = zstdCompressSync(encodeManifest([asset]))
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
    manifestZstd = zstdCompressSync(encodeManifest([asset]))
    // Always serve corrupt bytes: replace the body with something wrong.
    chunkBodies.set('b1', Buffer.from('XXXX'))
    const dest = await tmpDir()

    await expect(downloadSophonBuild(makeBuild(), dest, () => {})).rejects.toThrow(/校验失败/)
    expect(chunkReqs.get('b1')).toBe(3)
  })

  it('skips unchanged files (resume)', async () => {
    const asset = makeAsset('keep.bin', ['k1', 'k2'])
    manifestZstd = zstdCompressSync(encodeManifest([asset]))
    const dest = await tmpDir()
    await fs.writeFile(join(dest, 'keep.bin'), expectedContent(['k1', 'k2']))

    await downloadSophonBuild(makeBuild(), dest, () => {}, undefined, true)

    expect(chunkReqs.size).toBe(0)
  })

  it('completes an update from a partially pre-downloaded build', async () => {
    const done = makeAsset('done.bin', ['d1', 'd2'])
    const partial = makeAsset('partial.bin', ['p1', 'p2'])
    manifestZstd = zstdCompressSync(encodeManifest([done, partial]))

    // Pre-download was cancelled halfway: done.bin is complete, partial.bin only
    // has its first chunk.
    const pre = await tmpDir()
    await fs.writeFile(join(pre, 'done.bin'), expectedContent(['d1', 'd2']))
    await fs.writeFile(join(pre, 'partial.bin'), expectedContent(['p1']))

    // "promote": updateManager copies the staged pre-download into the game dir.
    const game = await tmpDir()
    await fs.cp(pre, game, { recursive: true })

    await downloadSophonBuild(makeBuild(), game, () => {}, undefined, true)

    expect(md5(await read(join(game, 'done.bin')))).toBe(done.md5)
    expect(md5(await read(join(game, 'partial.bin')))).toBe(partial.md5)
    // The complete file is reused, the incomplete one is re-downloaded.
    expect(chunkReqs.has('d1')).toBe(false)
    expect(chunkReqs.has('d2')).toBe(false)
    expect(chunkReqs.get('p1')).toBe(1)
    expect(chunkReqs.get('p2')).toBe(1)
  })
})
