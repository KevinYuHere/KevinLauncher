import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadFile } from '../src/main/services/downloader'

const CONTENT = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))
const MD5 = createHash('md5').update(CONTENT).digest('hex')

let server: Server
let baseUrl = ''
let requests: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.headers.range ?? '')
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? '')
    if (range) {
      const body = CONTENT.subarray(Number(range[1]))
      res.writeHead(206, { 'content-length': body.length })
      res.end(body)
      return
    }
    res.writeHead(200, { 'content-length': CONTENT.length })
    res.end(CONTENT)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'object' && address) baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const tmp = (): Promise<string> => fs.mkdtemp(join(tmpdir(), 'dl-test-'))

describe('downloadFile', () => {
  it('downloads a full file and verifies its md5', async () => {
    requests = []
    const dest = join(await tmp(), 'a.bin')
    await downloadFile({
      url: `${baseUrl}/a.bin`,
      dest,
      expectedSize: CONTENT.length,
      expectedMd5: MD5
    })
    expect(await fs.readFile(dest)).toEqual(CONTENT)
  })

  it('resumes from a partial file using an HTTP Range request', async () => {
    requests = []
    const dest = join(await tmp(), 'b.bin')
    await fs.writeFile(dest, CONTENT.subarray(0, 400)) // half finished
    await downloadFile({
      url: `${baseUrl}/b.bin`,
      dest,
      expectedSize: CONTENT.length,
      expectedMd5: MD5
    })
    expect(requests[0]).toBe('bytes=400-')
    expect(await fs.readFile(dest)).toEqual(CONTENT)
  })

  it('skips the request when the file is already complete', async () => {
    requests = []
    const dest = join(await tmp(), 'c.bin')
    await fs.writeFile(dest, CONTENT)
    await downloadFile({
      url: `${baseUrl}/c.bin`,
      dest,
      expectedSize: CONTENT.length,
      expectedMd5: MD5
    })
    expect(requests).toHaveLength(0)
  })

  it('re-downloads from scratch when the checksum does not match', async () => {
    requests = []
    const dest = join(await tmp(), 'd.bin')
    await fs.writeFile(dest, Buffer.alloc(CONTENT.length, 9)) // right size, wrong bytes
    await downloadFile({
      url: `${baseUrl}/d.bin`,
      dest,
      expectedSize: CONTENT.length,
      expectedMd5: MD5
    })
    expect(requests[0]).toBe('') // no Range header -> full re-fetch
    expect(await fs.readFile(dest)).toEqual(CONTENT)
  })

  it('rejects when the checksum still does not match', async () => {
    const dest = join(await tmp(), 'e.bin')
    await expect(
      downloadFile({ url: `${baseUrl}/e.bin`, dest, expectedSize: CONTENT.length, expectedMd5: 'deadbeef' })
    ).rejects.toThrow(/校验失败/)
  })
})
