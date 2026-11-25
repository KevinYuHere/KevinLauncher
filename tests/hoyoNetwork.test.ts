import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { md5Bytes } from '../src/main/services/hash'
import {
  downloadGameFile, downloadManifest, getHoYoMetadata, hoyoFetch, hoyoPortBudget, retryHoYo, withHoYoNetwork
} from '../src/main/update/hoyoNetwork'
import { startHoyoHttpFixture } from './fixtures/hoyoHttpFixture'

let directory: string
let server: Awaited<ReturnType<typeof startHoyoHttpFixture>>

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'hoyo-network-'))
  server = await startHoyoHttpFixture()
  Atomics.store(new BigUint64Array(hoyoPortBudget), 0, 0n)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await server.close()
  await fs.rm(directory, { recursive: true, force: true })
})

describe('Starward file transfer', () => {
  it.each(['honor', 'ignore'] as const)('resumes a complete file when the CDN will %s Range', async range => {
    server.route('/game', { body: '0123456789', range })
    const path = join(directory, 'game.tmp')
    await fs.writeFile(path, '012')
    await downloadGameFile({ path, url: server.url + '/game', size: 10 })
    expect(await fs.readFile(path, 'utf8')).toBe('0123456789')
    // A loopback fixture uses a non-default port, exercising HttpService's resend.
    expect(server.requests.map(request => request.range)).toEqual(['bytes=3-', 'bytes=3-'])
    expect(Atomics.load(new BigUint64Array(hoyoPortBudget), 0) & 15n).toBe(2n)
  })

  it('writes a resumed range at the local offset inside the selected patch slice', async () => {
    server.route('/patch', { body: '0123456789' })
    const path = join(directory, 'patch_4')
    await fs.writeFile(path, '45')
    await downloadGameFile({ path, url: server.url + '/patch', size: 4, offset: 4 })
    expect(await fs.readFile(path, 'utf8')).toBe('4567')
    expect(server.requests.map(request => request.range)).toEqual(['bytes=6-7', 'bytes=6-7'])
  })

  it('keeps a partial download after cancellation and resumes it on the next task', async () => {
    const interrupted = { after: 4, mode: 'wait' as const }
    server.route('/cancel', { body: '0123456789', interrupt: interrupted })
    const path = join(directory, 'cancel.tmp')
    const controller = new AbortController()
    await expect(downloadGameFile({
      path, url: server.url + '/cancel', size: 10, signal: controller.signal,
      onProgress: bytes => { if (bytes === 4) controller.abort() }
    })).rejects.toThrow()
    expect(await fs.readFile(path, 'utf8')).toBe('0123')

    server.route('/cancel', { body: '0123456789' })
    await downloadGameFile({ path, url: server.url + '/cancel', size: 10 })
    expect(await fs.readFile(path, 'utf8')).toBe('0123456789')
    expect(server.requests.map(request => request.range)).toEqual([null, null, 'bytes=4-', 'bytes=4-'])
  })

  it('retries a failed CDN request at the step boundary and skips resending the failed response', async () => {
    server.route('/retry', { status: 503 }, { body: 'good' })
    const path = join(directory, 'retry.tmp')
    await retryHoYo(() => downloadGameFile({ path, url: server.url + '/retry', size: 4 }))
    expect(await fs.readFile(path, 'utf8')).toBe('good')
    expect(server.requests).toHaveLength(3)
  })

  it('resumes the prefix retained after the CDN disconnects during the body', async () => {
    Atomics.store(new BigUint64Array(hoyoPortBudget), 0, (BigInt(Date.now() + 60_000) << 4n) + 10n)
    server.route('/broken', {
      body: '0123456789', interrupt: { after: 4, mode: 'disconnect', delayMs: 150 }
    }, { body: '0123456789' })
    const path = join(directory, 'broken.tmp')
    await retryHoYo(() => downloadGameFile({ path, url: server.url + '/broken', size: 10 }))
    expect(server.requests.map(request => request.range)).toEqual([null, 'bytes=4-'])
    expect(await fs.readFile(path, 'utf8')).toBe('0123456789')
  })

  it('does not start a second attempt after cancelling during a step retry delay', async () => {
    const controller = new AbortController()
    const operation = vi.fn(async () => {
      setImmediate(() => controller.abort())
      throw new Error('simulated network failure')
    })
    await expect(retryHoYo(operation, controller.signal)).rejects.toThrow()
    expect(operation).toHaveBeenCalledTimes(1)
  })
})

it('identifies each request as the installed KevinLauncher build', async () => {
  const userAgents: (string | null)[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    userAgents.push(new Headers(options?.headers).get('user-agent'))
    return Response.json({ retcode: 0 })
  })
  for (const role of ['desktop', 'runner'] as const) {
    await withHoYoNetwork(directory, role, () => hoyoFetch(server.url), '2.0.5-beta.2')
  }
  expect(userAgents).toEqual(['KevinLauncher/2.0.5-beta.2', 'KevinLauncher.Updater/2.0.5-beta.2'])
})

describe('Starward cache', () => {
  const zstd = (zlib as typeof zlib & { zstdCompressSync?: (bytes: Buffer) => Buffer }).zstdCompressSync

  it.skipIf(!zstd)('reuses the uncompressed manifest after a reload and validates size and digest', async () => {
    const plain = Buffer.from('verified protobuf fixture')
    const spec = {
      id: 'manifest-1',
      url: server.url + '/manifest',
      md5: md5Bytes(plain),
      uncompressedSize: plain.length,
      compressed: true
    }
    server.route('/manifest', { body: zstd!(plain) })
    const download = () => withHoYoNetwork(directory, 'desktop', () => downloadManifest(spec))
    expect(Buffer.from(await download())).toEqual(plain)
    const cachePath = join(directory, 'hoyo-cache', 'game', spec.id)
    expect(await fs.readFile(cachePath)).toEqual(plain)

    vi.resetModules()
    const restarted = await import('../src/main/update/hoyoNetwork')
    const onRestart = () => restarted.withHoYoNetwork(directory, 'runner', () => restarted.downloadManifest(spec))
    expect(Buffer.from(await onRestart())).toEqual(plain)
    expect(server.requests).toHaveLength(1)
    await fs.writeFile(cachePath, Buffer.alloc(plain.length))
    expect(Buffer.from(await onRestart())).toEqual(plain)
    expect(server.requests).toHaveLength(2)
    await fs.writeFile(cachePath, Buffer.concat([plain, Buffer.from('extra')]))
    await onRestart()
    expect(server.requests).toHaveLength(3)
  })

  it('does not publish a manifest with the wrong digest', async () => {
    const plain = Buffer.from('valid')
    const spec = {
      id: 'manifest-2',
      url: server.url + '/manifest',
      md5: md5Bytes(plain),
      uncompressedSize: plain.length,
      compressed: false
    }
    server.route('/manifest', { body: 'wrong' }, { body: plain })
    const download = () => withHoYoNetwork(directory, 'runner', () => downloadManifest(spec))
    await expect(download()).rejects.toThrow('MD5')
    await expect(fs.access(join(directory, 'hoyo-cache', 'game', spec.id))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(Buffer.from(await download())).toEqual(plain)
    expect(server.requests).toHaveLength(2)
  })

  it('keeps desktop metadata on disk and scopes the runner cache to memory', async () => {
    const key = 'metadata-test'
    const offline = vi.fn(async () => { throw new Error('offline') })
    const first = await withHoYoNetwork(directory, 'desktop', () => getHoYoMetadata(key, async () => 'desktop'))
    const runner = await withHoYoNetwork(directory, 'runner', () => getHoYoMetadata(key, async () => 'runner'))
    expect([first, runner]).toEqual(['desktop', 'runner'])

    vi.resetModules()
    const started = await import('../src/main/update/hoyoNetwork')
    expect(await started.withHoYoNetwork(directory, 'desktop', () => started.getHoYoMetadata(key, offline))).toBe('desktop')
    expect(offline).not.toHaveBeenCalled()
    await expect(started.withHoYoNetwork(directory, 'runner', () => started.getHoYoMetadata(key, offline))).rejects.toThrow('offline')

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000)
    expect(await started.withHoYoNetwork(directory, 'desktop', () => started.getHoYoMetadata(key, offline))).toBe('desktop')
    expect(await started.withHoYoNetwork(directory, 'desktop', () => started.getHoYoMetadata(key, offline))).toBe('desktop')
    expect(offline).toHaveBeenCalledTimes(2)
  })
})
