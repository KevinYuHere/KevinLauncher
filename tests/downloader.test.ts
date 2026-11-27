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
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/plain' })
      res.end()
      return
    }
    if (req.url === '/stall') {
      res.writeHead(200, { 'content-length': CONTENT.length })
      res.write(CONTENT.subarray(0, 50))
      return
    }
    if (req.url === '/range-unavailable' && range) {
      res.writeHead(416, { 'content-range': 'bytes */1000' })
      res.end()
      return
    }
    if (range && req.url !== '/ignored-range') {
      const body = CONTENT.subarray(Number(range[1]))
      res.writeHead(206, {
        'content-length': body.length,
        'content-range': `bytes ${req.url === '/wrong-range' ? Number(range[1]) - 1 : range[1]}-999/1000`
      })
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
    await expect(fs.access(dest)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['/ignored-range', '/range-unavailable', '/redirect'])('handles %s on an existing partial file', async (route) => {
    const dest = join(await tmp(), 'partial.bin')
    await fs.writeFile(dest + '.part', CONTENT.subarray(0, 400))
    await downloadFile({ url: baseUrl + route, dest, expectedSize: CONTENT.length, expectedMd5: MD5 })
    expect(await fs.readFile(dest)).toEqual(CONTENT)
  })

  it('keeps a valid partial file if the service supplies an invalid Content-Range', async () => {
    const dest = join(await tmp(), 'range.bin')
    await fs.writeFile(dest + '.part', CONTENT.subarray(0, 400))
    await expect(downloadFile({ url: baseUrl + '/wrong-range', dest, expectedSize: CONTENT.length, expectedMd5: MD5 }))
      .rejects.toThrow(/范围无效/)
    expect((await fs.stat(dest + '.part')).size).toBe(400)
    await expect(fs.access(dest)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('times out a stalled body and preserves a resumable partial without publishing it', async () => {
    const dest = join(await tmp(), 'timeout.bin')
    await expect(downloadFile({ url: baseUrl + '/stall', dest, expectedSize: CONTENT.length, expectedMd5: MD5, timeoutMs: 200 }))
      .rejects.toThrow()
    expect((await fs.stat(dest + '.part')).size).toBe(50)
    await expect(fs.access(dest)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
