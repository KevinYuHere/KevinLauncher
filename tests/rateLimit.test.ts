import { once } from 'node:events'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import {
  configureRateLimit, createDownloadWorker, readBodyThrottled
} from '../src/main/services/rateLimit'

it('applies one live download budget to a worker and the main thread', async () => {
  const size = 8192
  const payload = Buffer.alloc(size)
  const server = createServer((_req, res) => res.end(payload))
  await new Promise<void>(complete => server.listen(0, '127.0.0.1', complete))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server address')
  const url = `http://127.0.0.1:${address.port}`
  const worker = createDownloadWorker(resolve('tests/fixtures/downloadRateWorker.cjs'))

  try {
    expect(await once(worker, 'message')).toEqual(['ready'])
    // The main thread consumes one second of bandwidth. The same quota must
    // stop the worker from obtaining its own immediate full chunk.
    configureRateLimit(size / 1024 ** 2)
    expect(await readBodyThrottled(await fetch(url))).toEqual(payload)
    const headers = once(worker, 'message')
    worker.postMessage(url)
    expect(await headers).toEqual(['headers'])
    const completed = once(worker, 'message')
    const early = await Promise.race([
      completed.then(() => true),
      new Promise<false>(done => setTimeout(() => done(false), 40))
    ])
    expect(early).toBe(false)

    // Disabling the live setting immediately wakes the same waiting worker.
    configureRateLimit(0)
    expect(await completed).toEqual([size])
  } finally {
    configureRateLimit(0)
    await worker.terminate()
    await new Promise<void>(complete => server.close(() => complete()))
  }
})
