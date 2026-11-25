import { expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { build } from 'esbuild'
import * as zlib from 'zlib'
import { HoYoSteps } from '../src/main/update/hoyoSchedule'
import { HoYoWorker, HoYoWorkerStopped, type SophonSetup } from '../src/main/update/hoyoWorker'
import { fields } from '../src/main/update/sophonProto'
import { hoyoPortBudget } from '../src/main/update/hoyoNetwork'
import { gameWorkKey, temporaryGameFile } from '../src/main/update/hoyoTemp'
import { openSophonCacheOwnership } from '../src/main/update/sophonCacheOwnership'
import { startHoyoHttpFixture } from './fixtures/hoyoHttpFixture'

const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest('hex')
const silent = { phase() {}, progress() {} }

it('resumes at the interrupted step and retains completed steps until the final check', async () => {
  const calls: string[] = []
  const first = new AbortController()
  const steps = new HoYoSteps([
    async () => { calls.push('prepare') },
    async ({ signal }) => {
      calls.push('sdk')
      if (calls.filter(x => x === 'sdk').length === 1) first.abort()
      signal.throwIfAborted()
    },
    async () => { calls.push('ini') }
  ], async () => { calls.push('close') })
  await expect(steps.run({ ...silent, signal: first.signal })).rejects.toThrow()
  expect(calls).toEqual(['prepare', 'sdk'])
  await steps.run({ ...silent, signal: new AbortController().signal })
  await steps.close()
  expect(calls).toEqual(['prepare', 'sdk', 'sdk', 'ini', 'close'])
})

it('reports a fatal worker exit separately from a retryable command failure', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'kl-worker-exit-'))
  const script = join(dir, 'crash.cjs')
  await fs.writeFile(script, [
    "const { parentPort } = require('node:worker_threads')",
    "parentPort.on('message', ({type}) => {",
    "  if (type === 'verify') process.exit(19)",
    "  parentPort.postMessage({type: 'error', message: 'fixture transfer failed'})",
    "})"
  ].join('\n'))
  const worker = new HoYoWorker(script), ctx = { ...silent, signal: new AbortController().signal }
  try {
    const retryable = await worker.run({ type: 'update' }, ctx).catch(error => error)
    expect(retryable).toBeInstanceOf(Error)
    expect(retryable.message).toBe('fixture transfer failed')
    expect(retryable).not.toBeInstanceOf(HoYoWorkerStopped)
    await expect(worker.run({ type: 'verify' }, ctx)).rejects.toBeInstanceOf(HoYoWorkerStopped)
    await expect(worker.run({ type: 'update' }, ctx)).rejects.toBeInstanceOf(HoYoWorkerStopped)
  } finally {
    await worker.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

it('rejects truncated manifest fields while skipping unknown fixed-width metadata', () => {
  expect(() => [...fields(Buffer.from([10, 4, 1]))]).toThrow(/protobuf/)
  expect(() => [...fields(Buffer.from([0x80]))]).toThrow(/protobuf/)
  expect([...fields(Buffer.from([13, 0, 0, 0, 0, 16, 2]))]).toEqual([{ field: 2, wire: 0, num: 2n }])
})

it.skipIf(process.platform !== 'win32' || typeof zlib.zstdCompressSync !== 'function').each(['original', 'empty-base-zstd'])(
  'resumes predownload and applies a real HDIFF13 in a fresh worker (%s)', async format => {
  const root = await fs.mkdtemp(join(tmpdir(), 'kl-worker-'))
  const fixture = await startHoyoHttpFixture()
  let worker: HoYoWorker | undefined
  const ports = new BigUint64Array(hoyoPortBudget)
  const old = Atomics.exchange(ports, 0, (BigInt(Date.now() + 60_000) << 4n) + 10n)
  try {
    const script = join(root, 'sophon-worker.mjs')
    await build({ entryPoints: ['src/main/workers/sophonWorker.ts'], outfile: script, format: 'esm', platform: 'node', bundle: true,
      alias: { '@shared': resolve('src/shared') }, external: ['electron', 'node:sqlite'], logLevel: 'silent' })
    const game = join(await fs.realpath(root), '游戏文件')
    await fs.mkdir(game)
    const source = Buffer.from('old'), output = Buffer.from('changed')
    // A hand-encoded literal HDIFF13. The single RLE instruction describes unmodified literal output bytes.
    const noBase = format === 'empty-base-zstd'
    const literal = noBase ? zlib.zstdCompressSync(output) : output
    const diff = Buffer.concat([Buffer.from(noBase ? 'HDIFF13&zstd\0' : 'HDIFF13&\0'),
      Buffer.from([7, noBase ? 0 : 3, 0, 0, 0, 1, 0, 0, 0, 7, noBase ? literal.length : 0, 6]), literal])
    const blob = Buffer.concat([Buffer.from([9,8]), diff])
    const uint = (n: number): Buffer => n < 128 ? Buffer.from([n]) : Buffer.concat([Buffer.from([(n & 127) | 128]), uint(n >>> 7)])
    const num = (tag: number, n: number) => Buffer.concat([uint(tag * 8), uint(n)])
    const data = (tag: number, bytes: Buffer | string) => { const b = Buffer.from(bytes); return Buffer.concat([uint(tag * 8 + 2), uint(b.length), b]) }
    const delta = Buffer.concat([data(1, 'blob'), num(4, blob.length), data(5, md5(blob)), num(6, 2), num(7, diff.length),
      ...(noBase ? [] : [data(8, 'previous.bin'), num(9, source.length), data(10, md5(source))])])
    const item = Buffer.concat([data(1, 'patched.bin'), num(2, output.length), data(3, md5(output)), data(4, Buffer.concat([data(1, '1.0'), data(2, delta)]))])
    const manifest = Buffer.concat([data(1, item), num(3, 2)])
    fixture.route('/manifest', { body: manifest })
    fixture.route('/blob', { body: blob, interrupt: { after: 9, mode: 'wait' } }, { body: blob })
    const cacheTarget = gameWorkKey('test', '1.0', '2.0', 'sophon-cache')
    const work = gameWorkKey('test', '1.0', '2.0', 'preDownload')
    const setup: SophonSetup = {
      launcherVersion: '2.0.5', gameId: 'test', userData: join(root, 'user'), dir: game, version: '1.0', predownload: true,
      hpatchz: resolve('resources/hpatchz.exe'), blacklist: [], work, cacheTarget, plan: {
        kind: 'patch', mainBuild: { buildId: 'm', tag: '2.0', categories: [] },
        patch: { patchId: 'p', tag: '2.0', categories: [{ categoryId: 'game', matchingField: 'game', manifestId: 'manifest',
          manifestMd5: md5(manifest), manifestSize: manifest.length, manifestCompression: 0, manifestSuffix: '', manifestUrlPrefix: fixture.url,
          diffUrlPrefix: fixture.url, diffCompression: 0, diffSuffix: '', versions: {} }] }
      }
    }
    const ctx = { ...silent, signal: new AbortController().signal }
    worker = new HoYoWorker(script)
    await worker.run({ type: 'prepare', setup }, ctx)
    const controller = new AbortController()
    await expect(worker.run({ type: 'update' }, { ...silent, signal: controller.signal, progress(n) { if (n >= 9) controller.abort() } })).rejects.toThrow()
    expect((await fs.stat(temporaryGameFile(game, work, 'cache-downloads', join(game, 'ldiff', 'blob')))).size).toBe(9)
    await worker.run({ type: 'update' }, ctx)
    await worker.close()
    await fs.writeFile(join(game, 'previous.bin'), source)
    const donor = join(root, 'existing hard link')
    await fs.writeFile(donor, 'unrelated')
    await fs.link(donor, join(game, 'patched.bin.tmp'))
    await fs.link(donor, join(game, 'ldiff', 'blob_2'))
    const foreign = join(game, 'ldiff', 'foreign.tmp')
    const next = join(game, 'ldiff', 'next-version-blob')
    await fs.writeFile(foreign, 'third-party data')
    await fs.writeFile(next, 'next version')
    const nextCache = await openSophonCacheOwnership(game, gameWorkKey('test', '2.0', '3.0', 'sophon-cache'))
    await nextCache.record(next, true)
    await nextCache.save()
    worker = new HoYoWorker(script)
    await worker.run({ type: 'prepare', setup: { ...setup, predownload: false, work: gameWorkKey('test', '1.0', '2.0', 'update') } }, ctx)
    await worker.run({ type: 'update' }, ctx)
    await worker.run({ type: 'verify' }, ctx)
    expect(await fs.readFile(join(game, 'patched.bin'))).toEqual(output)
    expect(await fs.readFile(donor, 'utf8')).toBe('unrelated')
    const cache = await openSophonCacheOwnership(game, cacheTarget)
    await cache.release()
    await cache.save()
    await expect(fs.stat(join(game, 'ldiff', 'blob'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(foreign, 'utf8')).toBe('third-party data')
    expect(await fs.readFile(next, 'utf8')).toBe('next version')
    expect(await fs.readFile(join(game, 'ldiff', 'blob_2'), 'utf8')).toBe('unrelated')
    if (noBase) expect(await fs.readFile(join(game, 'previous.bin'))).toEqual(source)
    else await expect(fs.stat(join(game, 'previous.bin'))).rejects.toThrow()
    expect(fixture.requests.filter(r => r.path === '/blob').map(r => r.range)).toEqual([null, 'bytes=9-'])
  } finally {
    Atomics.store(ports, 0, old)
    await worker?.close()
    await fixture.close()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 20_000)
