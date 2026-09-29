import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { directorySize, downloadPayload, PARALLEL } from '../src/main/services/updateDownload'

let server: Server
let baseUrl = ''
let payload = Buffer.alloc(0)
let requests: string[] = []
let inFlight = 0
let maxInFlight = 0
let failFirst: Record<string, number> = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    const range = req.headers.range ?? ''
    requests.push(range)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    const match = /bytes=(\d+)-(\d+)/.exec(range)
    const start = match ? Number(match[1]) : 0
    const end = match ? Number(match[2]) + 1 : payload.length
    const body = payload.subarray(start, end)
    setTimeout(() => {
      inFlight--
      const remaining = failFirst[String(start)] ?? 0
      if (remaining > 0) {
        failFirst[String(start)] = remaining - 1
        res.statusCode = 500
        res.end('boom')
        return
      }
      res.writeHead(206, { 'content-length': body.length })
      res.end(body)
    }, 5)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'object' && address) baseUrl = `http://127.0.0.1:${address.port}/payload.zip`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  requests = []
  inFlight = 0
  maxInFlight = 0
  failFirst = {}
})

const tmp = (): Promise<string> => fs.mkdtemp(join(tmpdir(), 'payload-test-'))

describe('downloadPayload', () => {
  it('downloads over several connections', async () => {
    payload = randomBytes(600_000)
    const dest = join(await tmp(), 'payload.zip')
    await downloadPayload(baseUrl, dest, payload.length)
    expect(await fs.readFile(dest)).toEqual(payload)
    expect(maxInFlight).toBeGreaterThan(1)
  })

  it('reports progress up to the total size', async () => {
    payload = randomBytes(400_000)
    const dest = join(await tmp(), 'payload.zip')
    const seen: number[] = []
    await downloadPayload(baseUrl, dest, payload.length, (progress) => seen.push(progress.transferred))
    expect(seen.at(-1)).toBe(payload.length)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
  })

  it('resumes from the existing .part files', async () => {
    payload = randomBytes(400_000)
    const dest = join(await tmp(), 'payload.zip')
    const chunk = Math.ceil(payload.length / PARALLEL)
    await fs.writeFile(`${dest}.part0`, payload.subarray(0, chunk))
    await fs.writeFile(`${dest}.part1`, payload.subarray(chunk, chunk + 5000))

    await downloadPayload(baseUrl, dest, payload.length)

    expect(await fs.readFile(dest)).toEqual(payload)
    expect(requests).toContain(`bytes=${chunk + 5000}-${chunk * 2 - 1}`)
  })

  it('retries a failing connection', async () => {
    payload = randomBytes(200_000)
    failFirst = { '0': 2 }
    const dest = join(await tmp(), 'payload.zip')
    await downloadPayload(baseUrl, dest, payload.length)
    expect(await fs.readFile(dest)).toEqual(payload)
  })

  it('can be paused and then resumed without re-downloading', async () => {
    payload = randomBytes(800_000)
    const dest = join(await tmp(), 'payload.zip')
    const chunk = Math.ceil(payload.length / PARALLEL)

    // An aborted signal (i.e. the user pressed pause) must reject, leaving the
    // .part files behind.
    const controller = new AbortController()
    controller.abort()
    await expect(
      downloadPayload(baseUrl, dest, payload.length, undefined, controller.signal)
    ).rejects.toThrow()

    // Simulate the state after pausing: the first half of the first connection
    // is already on disk.
    await fs.mkdir(join(dest, '..'), { recursive: true })
    await fs.writeFile(`${dest}.part0`, payload.subarray(0, 10_000))
    requests = []
    await downloadPayload(baseUrl, dest, payload.length)

    expect(await fs.readFile(dest)).toEqual(payload)
    // The kept bytes are reused (a Range starting at 10 000) instead of restarting.
    expect(requests).toContain(`bytes=10000-${chunk - 1}`)
  })
})

describe('directorySize', () => {
  it('sums the files of a tree', async () => {
    const dir = await tmp()
    await fs.mkdir(join(dir, 'nested'), { recursive: true })
    await fs.writeFile(join(dir, 'a.bin'), Buffer.alloc(1000))
    await fs.writeFile(join(dir, 'nested', 'b.bin'), Buffer.alloc(500))
    expect(await directorySize(dir)).toBe(1500)
    expect(await directorySize(join(dir, 'missing'))).toBe(0)
  })
})
