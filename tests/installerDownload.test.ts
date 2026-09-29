import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  downloadInstaller,
  matches,
  planDiff,
  type BlockMap,
  type InstallerSource
} from '../src/main/services/installerDownload'

const BLOCK = 4096

let server: Server
let baseUrl = ''
let payload = Buffer.alloc(0)
let blockmapPayload = Buffer.alloc(0)
let requests: { range: string | null }[] = []
let inFlight = 0
let maxInFlight = 0
/** Number of times to fail a range request before serving it (per start byte). */
let failFirst: Record<string, number> = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    const isBlockmap = (req.url ?? '').includes('blockmap')
    const data = isBlockmap ? blockmapPayload : payload
    const range = isBlockmap ? null : (req.headers.range ?? null)
    if (!isBlockmap) {
      requests.push({ range })
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
    }
    const match = /bytes=(\d+)-(\d+)?/.exec(range ?? '')
    const start = match ? Number(match[1]) : 0
    const end = match && match[2] ? Number(match[2]) + 1 : data.length
    const body = data.subarray(start, end)
    setTimeout(() => {
      if (!isBlockmap) inFlight--
      const key = String(start)
      const remaining = failFirst[key] ?? 0
      if (remaining > 0) {
        failFirst[key] = remaining - 1
        res.statusCode = 500
        res.end('boom')
        return
      }
      res.writeHead(range ? 206 : 200, { 'content-length': body.length })
      res.end(body)
    }, 5)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'object' && address) baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  requests = []
  inFlight = 0
  maxInFlight = 0
  failFirst = {}
  blockmapPayload = Buffer.alloc(0)
})

const tmp = (): Promise<string> => fs.mkdtemp(join(tmpdir(), 'installer-test-'))
const sha512 = (data: Buffer): string => createHash('sha512').update(data).digest('base64')

function blockChecksums(data: Buffer): BlockMap {
  const sizes: number[] = []
  const checksums: string[] = []
  for (let offset = 0; offset < data.length; offset += BLOCK) {
    const block = data.subarray(offset, Math.min(data.length, offset + BLOCK))
    sizes.push(block.length)
    checksums.push(createHash('sha1').update(block).digest('hex'))
  }
  return { version: '2', files: [{ name: 'file', offset: 0, sizes, checksums }] }
}

function source(overrides: Partial<InstallerSource> = {}): InstallerSource {
  return {
    url: `${baseUrl}/installer.exe`,
    blockmapUrl: `${baseUrl}/installer.exe.blockmap`,
    size: payload.length,
    sha512: sha512(payload),
    fileName: 'KevinLauncher-Setup-9.9.9.exe',
    ...overrides
  }
}

describe('planDiff', () => {
  it('reuses unchanged blocks and only downloads the changed ones', () => {
    const oldData = randomBytes(BLOCK * 100)
    const newData = Buffer.from(oldData)
    newData.fill(0x7f, BLOCK * 40, BLOCK * 45) // 5 changed blocks

    const plan = planDiff(blockChecksums(oldData), blockChecksums(newData))

    expect(plan.copiedBytes).toBe(BLOCK * 95)
    expect(plan.downloadBytes).toBe(BLOCK * 5)
    expect(plan.download).toEqual([{ start: BLOCK * 40, end: BLOCK * 45 }])
    expect(plan.copy).toHaveLength(95)
  })
})

describe('downloadInstaller', () => {
  it('downloads over several connections and verifies the sha512', async () => {
    payload = randomBytes(600_000)
    const dir = await tmp()
    const path = await downloadInstaller(source(), dir, null)

    expect(await fs.readFile(path)).toEqual(payload)
    // Multiple parallel range requests => multi-threaded download.
    expect(maxInFlight).toBeGreaterThan(1)
    expect(requests.filter((r) => r.range).length).toBeGreaterThan(1)
  })

  it('resumes from the .part files of an interrupted full download', async () => {
    payload = randomBytes(400_000)
    const dir = await tmp()
    const dest = join(dir, 'KevinLauncher-Setup-9.9.9.exe')
    // Pretend the first connection already fetched its whole range and the
    // second one stopped halfway (chunks are ceil(size / 8) bytes).
    const chunk = Math.ceil(payload.length / 8)
    await fs.writeFile(`${dest}.part0`, payload.subarray(0, chunk))
    await fs.writeFile(`${dest}.part1`, payload.subarray(chunk, chunk + 1000))

    await downloadInstaller(source(), dir, null)

    expect(await fs.readFile(dest)).toEqual(payload)
    // The partially downloaded chunk continued with a Range request.
    expect(requests.some((r) => r.range === `bytes=${chunk + 1000}-${chunk * 2 - 1}`)).toBe(true)
  })

  it('retries a failing connection', async () => {
    payload = randomBytes(300_000)
    const dir = await tmp()
    failFirst = { '0': 2 } // the first range fails twice
    const path = await downloadInstaller(source(), dir, null)
    expect(await fs.readFile(path)).toEqual(payload)
  })

  it('assembles the new installer differentially from the cached one', async () => {
    const oldData = randomBytes(BLOCK * 60)
    const newData = Buffer.from(oldData)
    newData.fill(0x33, BLOCK * 10, BLOCK * 13) // 3 changed blocks
    payload = newData
    blockmapPayload = Buffer.from(JSON.stringify(blockChecksums(newData)))

    const dir = await tmp()
    const oldPath = join(dir, 'old-installer.exe')
    const oldBlockmapPath = `${oldPath}.blockmap`
    await fs.writeFile(oldPath, oldData)
    await fs.writeFile(oldBlockmapPath, JSON.stringify(blockChecksums(oldData)))

    const path = await downloadInstaller(
      { ...source(), size: newData.length, sha512: sha512(newData) },
      dir,
      { path: oldPath, blockmapPath: oldBlockmapPath }
    )

    expect(await fs.readFile(path)).toEqual(newData)
    // Only the changed range was requested (3 blocks), never the whole file.
    const downloaded = requests
      .filter((r) => r.range)
      .map((r) => r.range as string)
    expect(downloaded).toContain(`bytes=${BLOCK * 10}-${BLOCK * 13 - 1}`)
    expect(downloaded).toHaveLength(1)
  })

  it('rejects a corrupted download (sha512 mismatch)', async () => {
    payload = randomBytes(200_000)
    const dir = await tmp()
    await expect(
      downloadInstaller({ ...source(), sha512: sha512(randomBytes(10)) }, dir, null)
    ).rejects.toThrow(/校验失败/)
  })

  it('matches() checks size and sha512', async () => {
    payload = randomBytes(1000)
    const dir = await tmp()
    const path = join(dir, 'f.bin')
    await fs.writeFile(path, payload)
    expect(await matches(path, source())).toBe(true)
    expect(await matches(path, { ...source(), size: 5 })).toBe(false)
  })
})
